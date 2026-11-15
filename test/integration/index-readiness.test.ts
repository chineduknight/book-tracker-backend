import type { Connection } from 'mongoose';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { verifyIndexesUntilComplete } from '../../src/db/index-readiness.js';
import { createLogger } from '../../src/config/logger.js';
import type { ReadinessCheck } from '../../src/modules/health/health.routes.js';
import { buildMissingIndexes } from '../../scripts/indexes/build-missing-indexes.js';
import { createLogCapture, createTestApp, expectNoCredentials } from '../helpers.js';
import {
  databaseOf,
  dropDisposableDatabase,
  openDisposableDatabase,
  buildEveryRequiredIndex,
} from './disposable-databases.js';

let connection: Connection;

beforeEach(async () => {
  connection = await openDisposableDatabase('book-tracker-test-readiness-drill');
});

afterEach(async () => {
  await dropDisposableDatabase(connection);
});

function appGatedOn(isVerified: () => boolean) {
  const readiness: ReadinessCheck = () => (isVerified() ? undefined : 'indexes_unverified');
  return createTestApp({ readiness });
}

async function untilLogged(logs: { output: () => string }, message: string): Promise<void> {
  while (!logs.output().includes(message)) await new Promise((resolve) => setTimeout(resolve, 10));
}

describe('readiness gated on required indexes', () => {
  it('stays 503 while a unique index is missing, logging its name, and turns 200 once it is built', async () => {
    await buildEveryRequiredIndex(connection);
    await databaseOf(connection)
      .collection('readingsessions')
      .dropIndex('owner_book_single_in_progress');
    const logs = createLogCapture();
    let verified = false;
    const stop = new AbortController();
    const verifying = verifyIndexesUntilComplete({
      connection,
      logger: createLogger('info', logs.stream),
      signal: stop.signal,
      retryDelayMs: 20,
    }).then((result) => {
      verified = result;
    });
    const app = appGatedOn(() => verified);

    await untilLogged(logs, 'Required MongoDB indexes are missing or conflicting');
    const notReady = await request(app).get('/api/v1/ready');
    expect(notReady.status).toBe(503);
    expect(notReady.headers['cache-control']).toBe('no-store');
    expect(notReady.body.error).toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      message: 'Service is not ready: required database indexes are not verified',
    });
    expect(logs.output()).toContain('"index":"owner_book_single_in_progress","problem":"missing"');
    expect((await request(app).get('/api/v1/health')).status).toBe(200);

    await buildMissingIndexes(connection);
    await verifying;

    expect(verified).toBe(true);
    expect((await request(app).get('/api/v1/ready')).status).toBe(200);
    expectNoCredentials(logs.output());
  });

  it('never turns ready while a required index conflicts', async () => {
    await buildEveryRequiredIndex(connection);
    const tokens = databaseOf(connection).collection('refreshtokens');
    await tokens.dropIndex('sessionId_1');
    await tokens.createIndex({ sessionId: 1 }, { name: 'sessionId_1' });
    const logs = createLogCapture();
    const stop = new AbortController();
    const verifying = verifyIndexesUntilComplete({
      connection,
      logger: createLogger('info', logs.stream),
      signal: stop.signal,
      retryDelayMs: 20,
    });

    await untilLogged(logs, '"problem":"conflicting"');
    stop.abort();

    expect(await verifying).toBe(false);
    expect(logs.output()).not.toContain('Required MongoDB indexes verified');
  });

  it('stops checking when aborted, for shutdown, without waiting for the next attempt', async () => {
    const stop = new AbortController();
    const verifying = verifyIndexesUntilComplete({
      connection,
      logger: createLogger('silent'),
      signal: stop.signal,
      retryDelayMs: 60_000,
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    stop.abort();

    expect(await verifying).toBe(false);
  });
});
