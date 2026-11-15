import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type AddressInfo } from 'node:net';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';

export interface ApiProcess {
  child: ChildProcess;
  origin: string;
  port: number;
  /** Raw stdout and stderr, in order. */
  output(): string;
  /** Resolves once a log line with this exact `msg` has been written. */
  logged(message: string): Promise<void>;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

async function freePort(): Promise<number> {
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const { port } = probe.address() as AddressInfo;
  probe.close();
  await once(probe, 'close');
  return port;
}

/** Starts `src/server.ts` as a real process, as a host would, with the given environment. */
export async function startApiProcess(environment: Record<string, string>): Promise<ApiProcess> {
  const port = await freePort();
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
    env: {
      PATH: process.env.PATH ?? '',
      NODE_ENV: 'production',
      PORT: String(port),
      CORS_ORIGIN: 'https://books.example.test',
      JWT_ACCESS_TOKEN_SECRET: randomBytes(32).toString('base64url'),
      LOG_LEVEL: 'info',
      ...environment,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const lines: string[] = [];
  const messages = new Set<string>();
  const exited = once(child, 'exit').then(([code, signal]) => ({
    code: code as number | null,
    signal: signal as NodeJS.Signals | null,
  }));
  for (const stream of [child.stdout, child.stderr]) {
    createInterface({ input: stream }).on('line', (line) => {
      lines.push(line);
      try {
        const { msg } = JSON.parse(line) as { msg?: unknown };
        if (typeof msg === 'string') messages.add(msg);
      } catch {
        // stderr lines before the logger exists are plain text
      }
    });
  }
  const logged = async (message: string) => {
    while (!messages.has(message)) {
      if (child.exitCode !== null) throw new Error(`API exited before logging "${message}"`);
      await delay(20);
    }
  };
  return {
    child,
    origin: `http://127.0.0.1:${port}`,
    port,
    output: () => lines.join('\n'),
    logged,
    exited,
  };
}

export async function untilReady(api: ApiProcess): Promise<void> {
  await api.logged('HTTP server listening');
  while ((await fetch(`${api.origin}/api/v1/ready`)).status !== 200) await delay(50);
}
