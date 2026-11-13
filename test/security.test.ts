import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createLogger } from '../src/config/logger.js';
import { ALLOWED_ORIGIN, createLogCapture, createTestApp } from './helpers.js';

describe('security headers', () => {
  it('sets helmet headers and hides the framework', async () => {
    const res = await request(createTestApp()).get('/api/v1/health');

    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});

describe('CORS', () => {
  it('allows configured origins without enabling credentials', async () => {
    const res = await request(createTestApp()).get('/api/v1/health').set('Origin', ALLOWED_ORIGIN);

    expect(res.headers['access-control-allow-origin']).toBe(ALLOWED_ORIGIN);
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('does not allow other origins', async () => {
    const res = await request(createTestApp())
      .get('/api/v1/health')
      .set('Origin', 'https://evil.example');

    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('request ids', () => {
  it('generates a request id when none is supplied', async () => {
    const res = await request(createTestApp()).get('/api/v1/health');

    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('echoes a safe caller-supplied request id', async () => {
    const res = await request(createTestApp()).get('/api/v1/health').set('X-Request-Id', 'abc-123');

    expect(res.headers['x-request-id']).toBe('abc-123');
  });

  it('replaces an unsafe caller-supplied request id', async () => {
    const res = await request(createTestApp())
      .get('/api/v1/health')
      .set('X-Request-Id', '<script>alert(1)</script>');

    expect(res.headers['x-request-id']).not.toContain('<script>');
  });
});

describe('request logging', () => {
  it('logs method, path and status but not credentials or query strings', async () => {
    const logs = createLogCapture();
    const app = createApp({
      logger: createLogger('info', logs.stream),
      corsOrigins: [ALLOWED_ORIGIN],
    });

    await request(app)
      .get('/api/v1/health?token=query-secret')
      .set('Authorization', 'Bearer header-secret')
      .set('Cookie', 'session=cookie-secret');

    const output = logs.output();
    expect(output).toContain('"path":"/api/v1/health"');
    expect(output).toContain('"statusCode":200');
    expect(output).not.toContain('query-secret');
    expect(output).not.toContain('header-secret');
    expect(output).not.toContain('cookie-secret');
  });

  it('redacts sensitive fields logged by application code', () => {
    const logs = createLogCapture();
    const logger = createLogger('info', logs.stream);

    logger.info(
      { user: { password: 'pw-secret' }, req: { headers: { authorization: 'Bearer x-secret' } } },
      'test',
    );

    expect(logs.output()).not.toContain('pw-secret');
    expect(logs.output()).not.toContain('x-secret');
    expect(logs.output()).toContain('[REDACTED]');
  });
});
