import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { SmokeRunError } from './smoke-errors.js';

const STARTUP_TIMEOUT_MS = 30_000;
const LISTENING_MESSAGE = 'HTTP server listening';
const WARNING_LEVEL = 40;

interface ApiLogLine {
  level?: number;
  msg?: string;
  port?: number;
}

function parseLogLine(line: string): ApiLogLine | undefined {
  try {
    return JSON.parse(line) as ApiLogLine;
  } catch {
    return undefined;
  }
}

export async function ensurePortIsFree(port: number): Promise<void> {
  const probe = createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      probe.once('error', reject);
      probe.listen(port, resolve);
    });
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EADDRINUSE') {
      throw new SmokeRunError(
        `port ${port} is already in use; stop that process or set SMOKE_PORT`,
      );
    }
    throw error;
  } finally {
    if (probe.listening) await new Promise((resolve) => probe.close(resolve));
  }
}

export function startApi(port: number, databaseUri: string): ChildProcess {
  return spawn(process.execPath, ['dist/server.js'], {
    env: {
      ...process.env,
      PORT: String(port),
      MONGODB_URI: databaseUri,
      JWT_ACCESS_TOKEN_SECRET: randomBytes(32).toString('base64url'),
      LOG_LEVEL: 'info',
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
}

/**
 * Resolves only when the given child reports that it bound `port` itself, so a readiness
 * response afterwards cannot come from another process that already owned the port.
 * Warnings and errors from the child are forwarded to stderr; routine request logs are not.
 */
export function waitUntilApiListens(api: ChildProcess, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () =>
        reject(
          new SmokeRunError(`the API did not start listening within ${STARTUP_TIMEOUT_MS / 1000}s`),
        ),
      STARTUP_TIMEOUT_MS,
    );
    const finish = (outcome: () => void) => {
      clearTimeout(timeout);
      api.off('exit', onExit);
      outcome();
    };
    const onExit = () =>
      finish(() => reject(new SmokeRunError('the API exited before it started listening')));
    api.once('exit', onExit);

    if (!api.stdout) {
      finish(() => reject(new SmokeRunError('the API output is not available')));
      return;
    }
    createInterface({ input: api.stdout }).on('line', (line) => {
      const logLine = parseLogLine(line);
      if ((logLine?.level ?? 0) >= WARNING_LEVEL) process.stderr.write(`${line}\n`);
      if (logLine?.msg === LISTENING_MESSAGE && logLine.port === port) finish(resolve);
    });
  });
}

export async function waitUntilReady(api: ChildProcess, readyUrl: string): Promise<void> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (api.exitCode !== null) throw new SmokeRunError('the API exited before becoming ready');
    try {
      if ((await fetch(readyUrl)).ok) return;
    } catch {
      // The database connection may still be starting.
    }
    await delay(250);
  }
  throw new SmokeRunError(`the API was not ready within ${STARTUP_TIMEOUT_MS / 1000}s`);
}

export async function stopApi(api: ChildProcess): Promise<void> {
  if (api.exitCode !== null || api.signalCode !== null) return;
  api.kill('SIGTERM');
  await once(api, 'exit');
}
