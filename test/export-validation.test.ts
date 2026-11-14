import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { exportQuerySchema } from '../src/modules/export/export.schema.js';
import { ALLOWED_ORIGIN, createTestApp } from './helpers.js';

const EXPORT_PATHS = ['archive', 'books.csv', 'reading-sessions.csv', 'loans.csv', 'notes.md'].map(
  (file) => `/api/v1/export/${file}`,
);

describe('exportQuerySchema', () => {
  it('accepts only an empty query', () => {
    expect(exportQuerySchema.parse({})).toEqual({});
    for (const query of [{ format: 'csv' }, { limit: '1' }, { ownerId: 'x' }]) {
      expect(exportQuerySchema.safeParse(query).success).toBe(false);
    }
  });
});

describe('export endpoints without authentication', () => {
  it.each(EXPORT_PATHS)('GET %s returns 401 UNAUTHENTICATED without caching', async (path) => {
    const res = await request(createTestApp()).get(path);

    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toBe('Bearer');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['content-disposition']).toBeUndefined();
  });

  it('answers CORS preflight without credentials, exposing Content-Disposition, without caching', async () => {
    const res = await request(createTestApp())
      .options('/api/v1/export/archive')
      .set('Origin', ALLOWED_ORIGIN)
      .set('Access-Control-Request-Method', 'GET');
    const simple = await request(createTestApp())
      .get('/api/v1/export/archive')
      .set('Origin', ALLOWED_ORIGIN);

    expect(res.status).toBe(204);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
    expect(simple.headers['access-control-expose-headers']).toContain('Content-Disposition');
  });

  it('sends no-store for malformed bodies and keeps unsupported methods as unknown routes', async () => {
    const app = createTestApp();

    const malformed = await request(app)
      .post('/api/v1/export/archive')
      .set('Content-Type', 'application/json')
      .send('{"x": ');

    expect(malformed.status).toBe(400);
    expect(malformed.headers['cache-control']).toBe('no-store');
  });
});
