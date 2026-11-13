import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import mongoose from 'mongoose';

const SMOKE_DATABASE_NAME = 'book-tracker-smoke';
const READY_TIMEOUT_MS = 30_000;

const smokeDatabaseUri =
  process.env.MONGODB_SMOKE_URI ?? `mongodb://127.0.0.1:27017/${SMOKE_DATABASE_NAME}`;
const port = process.env.SMOKE_PORT ?? '3100';
const baseUrl = `http://127.0.0.1:${port}/api/v1`;

function databaseNameIn(uri: string): string | undefined {
  return uri.split('/')[3]?.split('?')[0];
}

function report(message: string): void {
  process.stdout.write(`[api:smoke] ${message}\n`);
}

function requireDedicatedSmokeDatabase(): void {
  if (databaseNameIn(smokeDatabaseUri) !== SMOKE_DATABASE_NAME) {
    throw new Error(`MONGODB_SMOKE_URI must name the ${SMOKE_DATABASE_NAME} database`);
  }
}

async function resetSmokeDatabase(): Promise<void> {
  await mongoose.connect(smokeDatabaseUri, {
    dbName: SMOKE_DATABASE_NAME,
    serverSelectionTimeoutMS: 5_000,
  });
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
}

function startApi(): ChildProcess {
  return spawn(process.execPath, ['dist/server.js'], {
    env: {
      ...process.env,
      PORT: port,
      MONGODB_URI: smokeDatabaseUri,
      JWT_ACCESS_TOKEN_SECRET: randomBytes(32).toString('base64url'),
      LOG_LEVEL: 'warn',
    },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
}

async function waitUntilReady(api: ChildProcess): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (api.exitCode !== null) throw new Error('the API exited before becoming ready');
    try {
      if ((await fetch(`${baseUrl}/ready`)).ok) return;
    } catch {
      // Not listening yet.
    }
    await delay(250);
  }
  throw new Error(`the API was not ready within ${READY_TIMEOUT_MS / 1000}s`);
}

async function runBrunoCollection(): Promise<number> {
  const bruno = spawn('npm', ['run', 'api:test', '--', '--env-var', `baseUrl=${baseUrl}`], {
    stdio: 'inherit',
  });
  const [exitCode] = (await once(bruno, 'exit')) as [number | null];
  return exitCode ?? 1;
}

async function stopApi(api: ChildProcess): Promise<void> {
  if (api.exitCode !== null) return;
  api.kill('SIGTERM');
  await once(api, 'exit');
}

async function main(): Promise<void> {
  requireDedicatedSmokeDatabase();
  report(`resetting ${SMOKE_DATABASE_NAME}`);
  await resetSmokeDatabase();
  const api = startApi();
  try {
    await waitUntilReady(api);
    report(`API ready at ${baseUrl}; running the Bruno collection`);
    process.exitCode = await runBrunoCollection();
  } finally {
    await stopApi(api);
  }
}

main().catch((error: unknown) => {
  report(`failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
