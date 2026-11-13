import type { Writable } from 'node:stream';
import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createLogger } from '../src/config/logger.js';
import { errorHandler, notFoundHandler } from '../src/middleware/error-handler.js';
import { requestLogger } from '../src/middleware/request-logger.js';
import { AppError } from '../src/shared/errors.js';
import {
  createCredentialError,
  createLogCapture,
  createTestApp,
  CREDENTIAL_URI,
  expectNoCredentials,
} from './helpers.js';

/** A minimal app wired with the production middleware, plus routes that throw on purpose. */
function createThrowingApp(logStream?: Writable) {
  const logger = logStream ? createLogger('info', logStream) : createLogger('silent');
  const app = express();
  app.use(requestLogger(logger));
  app.get('/boom', () => {
    throw createCredentialError();
  });
  app.get('/boom-string', () => {
    // eslint-disable-next-line @typescript-eslint/only-throw-error -- simulating a careless throw
    throw CREDENTIAL_URI;
  });
  app.get('/rejected', async () => {
    await Promise.resolve();
    throw new Error('async failure');
  });
  app.get('/conflict', () => {
    throw new AppError(409, 'CONFLICT', 'Already exists', { field: 'isbn' });
  });
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

describe('unknown routes', () => {
  it.each(['/api/v1/does-not-exist', '/', '/api/v2/health'])(
    'returns a JSON 404 for %s',
    async (path) => {
      const res = await request(createTestApp()).get(path);

      expect(res.status).toBe(404);
      expect(res.body).toEqual({
        error: { code: 'NOT_FOUND', message: 'Route not found', requestId: expect.any(String) },
      });
    },
  );
});

describe('unsupported methods on known paths', () => {
  it('returns 404 NOT_FOUND rather than 405', async () => {
    const res = await request(createTestApp()).post('/api/v1/health').send({});

    expect(res.status).toBe(404);
    expect(res.body.error).toMatchObject({ code: 'NOT_FOUND', message: 'Route not found' });
  });
});

describe('error serialization', () => {
  it('serializes AppError with its status, code and details', async () => {
    const res = await request(createThrowingApp()).get('/conflict');

    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: {
        code: 'CONFLICT',
        message: 'Already exists',
        requestId: expect.any(String),
        details: { field: 'isbn' },
      },
    });
  });

  it('hides unexpected errors behind a generic 500', async () => {
    const res = await request(createThrowingApp()).get('/boom');

    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'An unexpected error occurred',
        requestId: expect.any(String),
      },
    });
    expectNoCredentials(res.text);
    expect(res.text).not.toContain('stack');
  });

  it('handles rejected promises from async handlers', async () => {
    const res = await request(createThrowingApp()).get('/rejected');

    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('INTERNAL_ERROR');
  });

  it.each(['/boom', '/boom-string'])(
    'logs %s at error level with the request id but without credentials',
    async (path) => {
      const logs = createLogCapture();
      const res = await request(createThrowingApp(logs.stream)).get(path);

      expectNoCredentials(res.text);
      expectNoCredentials(logs.output());
      const line = JSON.parse(logs.output().trim()) as Record<string, unknown>;
      expect(line).toMatchObject({
        level: 50,
        req: { id: res.body.error.requestId, path },
        res: { statusCode: 500 },
        err: { name: 'Error' },
      });
    },
  );

  it('rejects malformed JSON with 400 INVALID_JSON', async () => {
    const res = await request(createTestApp())
      .post('/api/v1/health')
      .set('Content-Type', 'application/json')
      .send('{"title": ');

    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({ code: 'INVALID_JSON' });
  });

  it('rejects bodies over the size limit with 413 PAYLOAD_TOO_LARGE', async () => {
    const res = await request(createTestApp())
      .post('/api/v1/health')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ text: 'x'.repeat(200 * 1024) }));

    expect(res.status).toBe(413);
    expect(res.body.error).toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
  });

  it('rejects unsupported body charsets with 415 UNSUPPORTED_MEDIA_TYPE', async () => {
    const res = await request(createTestApp())
      .post('/api/v1/health')
      .set('Content-Type', 'application/json; charset=latin9')
      .send('{}');

    expect(res.status).toBe(415);
    expect(res.body.error).toMatchObject({
      code: 'UNSUPPORTED_MEDIA_TYPE',
      message: 'Request body encoding is not supported',
    });
  });
});
