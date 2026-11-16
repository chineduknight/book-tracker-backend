import { once } from 'node:events';
import { connect, type Socket } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import type { Connection } from 'mongoose';
import { afterEach, describe, expect, it } from 'vitest';
import { CREDENTIAL_URI, expectNoCredentials } from '../helpers.js';
import { startApiProcess, untilReady, type ApiProcess } from '../support/api-process.js';
import {
  databaseOf,
  disposableDatabaseUri,
  dropDisposableDatabase,
  openDisposableDatabase,
  buildEveryRequiredIndex,
} from './disposable-databases.js';
import { testDatabaseUri } from './test-database.js';

const LOGIN_BODY = JSON.stringify({ email: 'not-an-email', password: 'x' });

let api: ApiProcess | undefined;
let drill: Connection | undefined;

async function startReadyApi(): Promise<ApiProcess> {
  api = await startApiProcess({ MONGODB_URI: testDatabaseUri() });
  await untilReady(api);
  return api;
}

/** A login request whose body is still arriving: an in-flight request from the server's view. */
async function startUnfinishedLogin({ port }: ApiProcess): Promise<Socket> {
  const socket = connect({ port, host: '127.0.0.1' });
  await once(socket, 'connect');
  socket.write(
    'POST /api/v1/auth/login HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\n' +
      `Content-Length: ${Buffer.byteLength(LOGIN_BODY)}\r\n\r\n${LOGIN_BODY.slice(0, 5)}`,
  );
  return socket;
}

async function responseOn(socket: Socket): Promise<string> {
  const chunks: Buffer[] = [];
  socket.on('data', (chunk: Buffer) => chunks.push(chunk));
  await once(socket, 'close');
  return Buffer.concat(chunks).toString('utf8');
}

async function refusesConnections(port: number): Promise<boolean> {
  const socket = connect({ port, host: '127.0.0.1' });
  try {
    await once(socket, 'connect');
    return false;
  } catch {
    return true;
  } finally {
    socket.destroy();
  }
}

afterEach(async () => {
  if (api && api.child.exitCode === null && api.child.signalCode === null) {
    api.child.kill('SIGKILL');
    await api.exited;
  }
  api = undefined;
  if (drill) await dropDisposableDatabase(drill);
  drill = undefined;
});

describe('API process lifecycle (subprocess, production configuration)', () => {
  it.each(['SIGTERM', 'SIGINT'] as const)(
    'on %s stops listening, disconnects MongoDB and exits 0 without the forced-exit timer',
    async (signal) => {
      const running = await startReadyApi();

      running.child.kill(signal);
      const exit = await running.exited;

      expect(exit).toEqual({ code: 0, signal: null });
      expect(running.output()).toContain('"msg":"Shutdown complete"');
      expect(running.output()).not.toContain('Shutdown timed out');
      expect(running.output()).toContain('"rateLimitStore":"memory"');
    },
  );

  it('lets an in-flight request finish after SIGTERM while refusing new connections', async () => {
    const running = await startReadyApi();
    const inFlight = await startUnfinishedLogin(running);
    const response = responseOn(inFlight);

    running.child.kill('SIGTERM');
    await running.logged('Shutdown started');
    expect(await refusesConnections(running.port)).toBe(true);
    inFlight.write(LOGIN_BODY.slice(5));

    expect(await response).toMatch(/^HTTP\/1\.1 400 /);
    expect(await running.exited).toEqual({ code: 0, signal: null });
    expect(running.output()).not.toContain('Requests still open after draining');
  });

  it('closes idle keep-alive connections at once instead of waiting for their timeout', async () => {
    const running = await startReadyApi();
    const keptAlive = connect({ port: running.port, host: '127.0.0.1' });
    await once(keptAlive, 'connect');
    keptAlive.write('GET /api/v1/health HTTP/1.1\r\nHost: localhost\r\n\r\n');
    await once(keptAlive, 'data');
    const closed = once(keptAlive, 'close');

    running.child.kill('SIGTERM');

    await closed;
    expect(await running.exited).toEqual({ code: 0, signal: null });
  });

  it('closes requests that are still open after the drain period, then exits 0', async () => {
    const running = await startReadyApi();
    const stalled = await startUnfinishedLogin(running);

    running.child.kill('SIGTERM');

    expect(await running.exited).toEqual({ code: 0, signal: null });
    expect(running.output()).toContain('Requests still open after draining; closing them');
    stalled.destroy();
  }, 20_000);

  it('exits 1 at once on a second signal during shutdown', async () => {
    const running = await startReadyApi();
    const stalled = await startUnfinishedLogin(running);
    running.child.kill('SIGTERM');
    await running.logged('Shutdown started');

    running.child.kill('SIGTERM');

    expect(await running.exited).toEqual({ code: 1, signal: null });
    expect(running.output()).toContain('Second shutdown signal; exiting immediately');
    stalled.destroy();
  });

  it('is live but not ready while MongoDB is unreachable, and still shuts down cleanly', async () => {
    api = await startApiProcess({ MONGODB_URI: 'mongodb://127.0.0.1:9/book-tracker' });
    await api.logged('HTTP server listening');

    const liveness = await fetch(`${api.origin}/api/v1/health`);
    const readiness = await fetch(`${api.origin}/api/v1/ready`);
    api.child.kill('SIGTERM');

    expect(liveness.status).toBe(200);
    expect(readiness.status).toBe(503);
    expect(await readiness.json()).toMatchObject({
      error: { message: 'Service is not ready: database is not connected' },
    });
    expect(await api.exited).toEqual({ code: 0, signal: null });
  });

  it('stays not ready in production while a required unique index is missing, and builds none itself', async () => {
    drill = await openDisposableDatabase('book-tracker-test-process-drill');
    await buildEveryRequiredIndex(drill);
    await databaseOf(drill).collection('loans').dropIndex('owner_copy_single_active');
    api = await startApiProcess({
      MONGODB_URI: disposableDatabaseUri('book-tracker-test-process-drill'),
    });

    await api.logged(
      'Required MongoDB indexes are missing or conflicting; the API stays not ready',
    );
    const readiness = await fetch(`${api.origin}/api/v1/ready`);
    await delay(200);

    expect(readiness.status).toBe(503);
    expect(await readiness.json()).toMatchObject({
      error: { message: 'Service is not ready: required database indexes are not verified' },
    });
    expect(api.output()).toContain('"index":"owner_copy_single_active","problem":"missing"');
    const loanIndexes = await databaseOf(drill).collection('loans').indexes();
    expect(loanIndexes.map(({ name }) => name)).not.toContain('owner_copy_single_active');
    api.child.kill('SIGTERM');
    expect(await api.exited).toEqual({ code: 0, signal: null });
  });

  it('refuses to start in production with an unsafe configuration, naming only the variable', async () => {
    api = await startApiProcess({
      MONGODB_URI: CREDENTIAL_URI,
      CORS_ORIGIN: 'http://books.example.test',
      MONGODB_TEST_URI: CREDENTIAL_URI,
    });

    expect(await api.exited).toEqual({ code: 1, signal: null });
    expect(api.output()).toContain('CORS_ORIGIN: must list only https:// origins in production');
    expect(api.output()).toContain('MONGODB_TEST_URI: must not be set in production');
    expectNoCredentials(api.output());
  });
});
