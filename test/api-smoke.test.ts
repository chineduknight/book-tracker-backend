import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { ensurePortIsFree, waitUntilApiListens } from '../scripts/smoke/smoke-api-process.js';
import { describeSmokeFailure, SmokeRunError } from '../scripts/smoke/smoke-errors.js';
import { toLocalSmokeDatabaseUri, toSmokePort } from '../scripts/smoke/smoke-target.js';
import { createCredentialError, expectNoCredentials } from './helpers.js';

const openServers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    openServers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))),
  );
});

async function listeningStub(): Promise<{ port: number; requests: string[] }> {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(req.url ?? '');
    res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"data":{"status":"ready"}}');
  });
  openServers.push(server);
  server.listen(0);
  await once(server, 'listening');
  return { port: (server.address() as AddressInfo).port, requests };
}

function fakeApi(script: string) {
  return spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'inherit'] });
}

async function runSmokeScript(env: Record<string, string>) {
  const runner = spawn(process.execPath, ['--import', 'tsx', 'scripts/api-smoke.ts'], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  runner.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
  runner.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
  const [exitCode] = (await once(runner, 'exit')) as [number | null];
  return { exitCode, output };
}

describe('smoke database target', () => {
  it.each([
    [
      'mongodb://127.0.0.1:27017/book-tracker-smoke',
      'mongodb://127.0.0.1:27017/book-tracker-smoke?directConnection=true',
    ],
    [
      'mongodb://localhost/book-tracker-smoke',
      'mongodb://localhost/book-tracker-smoke?directConnection=true',
    ],
    [
      'mongodb://[::1]:27018/book-tracker-smoke',
      'mongodb://[::1]:27018/book-tracker-smoke?directConnection=true',
    ],
    [
      'mongodb://user:pass@127.0.0.1/book-tracker-smoke?authSource=admin',
      'mongodb://user:pass@127.0.0.1/book-tracker-smoke?authSource=admin&directConnection=true',
    ],
  ])('accepts the local target %s', (uri, expected) => {
    expect(toLocalSmokeDatabaseUri(uri)).toBe(expected);
  });

  it.each([
    ['an SRV cluster', 'mongodb+srv://admin:hunter2@cluster0.db.example.test/book-tracker-smoke'],
    ['a remote host', 'mongodb://admin:hunter2@db.example.test:27017/book-tracker-smoke'],
    ['a remote IP address', 'mongodb://admin:hunter2@10.0.0.5/book-tracker-smoke'],
    [
      'a host that only starts like localhost',
      'mongodb://admin:hunter2@localhost.example.test/book-tracker-smoke',
    ],
    ['several hosts', 'mongodb://admin:hunter2@127.0.0.1,db.example.test/book-tracker-smoke'],
    ['another database', 'mongodb://admin:hunter2@127.0.0.1/book-tracker'],
    ['no database', 'mongodb://admin:hunter2@127.0.0.1'],
    [
      'replica-set discovery',
      'mongodb://admin:hunter2@127.0.0.1/book-tracker-smoke?replicaSet=rs0',
    ],
    ['a proxy', 'mongodb://admin:hunter2@127.0.0.1/book-tracker-smoke?proxyHost=db.example.test'],
    [
      'disabled direct connection',
      'mongodb://admin:hunter2@127.0.0.1/book-tracker-smoke?directConnection=false',
    ],
    ['not a MongoDB URI', 'postgres://admin:hunter2@127.0.0.1/book-tracker-smoke'],
  ])('rejects %s without echoing the URI', (_label, uri) => {
    let failure: unknown;
    try {
      toLocalSmokeDatabaseUri(uri);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(SmokeRunError);
    expect(describeSmokeFailure(failure)).not.toContain('hunter2');
    expect(describeSmokeFailure(failure)).not.toContain('example.test');
  });

  it.each(['0', '65536', 'abc', '3100.5', ''])('rejects SMOKE_PORT=%j', (port) => {
    expect(() => toSmokePort(port)).toThrow(SmokeRunError);
  });
});

describe('smoke failure messages', () => {
  it('reports only the name and code of unexpected errors', () => {
    const description = describeSmokeFailure(createCredentialError());

    expect(description).toBe('Error (ECONNREFUSED)');
    expectNoCredentials(description);
  });

  it('reports the runner’s own messages in full', () => {
    expect(describeSmokeFailure(new SmokeRunError('port 3100 is already in use'))).toBe(
      'port 3100 is already in use',
    );
  });
});

describe('smoke API port ownership', () => {
  it('refuses a port another process already listens on', async () => {
    const stub = await listeningStub();

    await expect(ensurePortIsFree(stub.port)).rejects.toThrow(
      new SmokeRunError(`port ${stub.port} is already in use; stop that process or set SMOKE_PORT`),
    );
  });

  it('accepts a free port and releases it again', async () => {
    const stub = await listeningStub();
    const port = stub.port;
    await new Promise((resolve) => openServers.splice(0)[0]?.close(resolve));

    await expect(ensurePortIsFree(port)).resolves.toBeUndefined();
    await expect(ensurePortIsFree(port)).resolves.toBeUndefined();
  });

  it('accepts readiness only after the started process reports listening on the port', async () => {
    const api = fakeApi(
      `console.log(JSON.stringify({ level: 30, msg: 'HTTP server listening', port: 4321 }));
       setTimeout(() => {}, 5000);`,
    );

    await expect(waitUntilApiListens(api, 4321)).resolves.toBeUndefined();
    api.kill();
  });

  it.each([
    ['exits before listening (for example EADDRINUSE)', `process.exit(1);`],
    [
      'reports listening on another port',
      `console.log(JSON.stringify({ level: 30, msg: 'HTTP server listening', port: 9999 }));
       setTimeout(() => process.exit(1), 100);`,
    ],
  ])('fails when the started process %s', async (_label, script) => {
    const api = fakeApi(script);

    await expect(waitUntilApiListens(api, 4321)).rejects.toThrow(
      new SmokeRunError('the API exited before it started listening'),
    );
  });
});

describe('npm run api:smoke safeguards', () => {
  it('stops before touching any database or running Bruno when the port is taken', async () => {
    const stub = await listeningStub();

    const { exitCode, output } = await runSmokeScript({ SMOKE_PORT: String(stub.port) });

    expect(exitCode).toBe(1);
    expect(output).toContain(`port ${stub.port} is already in use`);
    expect(output).not.toContain('resetting');
    expect(output).not.toContain('running the Bruno collection');
    expect(stub.requests).toEqual([]);
  }, 30_000);

  it('refuses a remote database before connecting and never prints its credentials', async () => {
    const { exitCode, output } = await runSmokeScript({
      MONGODB_SMOKE_URI: 'mongodb+srv://admin:hunter2@cluster0.db.example.test/book-tracker-smoke',
    });

    expect(exitCode).toBe(1);
    expect(output).toContain('failed: MONGODB_SMOKE_URI must be a mongodb:// URI');
    expect(output).not.toContain('resetting');
    for (const secretPart of ['hunter2', 'admin:', 'cluster0', 'example.test']) {
      expect(output).not.toContain(secretPart);
    }
  }, 30_000);
});
