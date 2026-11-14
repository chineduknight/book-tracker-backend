import request from 'supertest';
import { describe, expect, it } from 'vitest';
import {
  readingStatisticsQuerySchema,
  recentActivityQuerySchema,
  summaryQuerySchema,
} from '../src/modules/dashboard/dashboard.schema.js';
import { createTestApp } from './helpers.js';

describe('summaryQuerySchema', () => {
  it('accepts no parameters or a single existing calendar day', () => {
    expect(summaryQuerySchema.parse({})).toEqual({});
    expect(summaryQuerySchema.parse({ asOf: '2024-02-29' })).toEqual({ asOf: '2024-02-29' });
  });

  it.each([
    { asOf: '2026-02-29' },
    { asOf: '2026-11-14T00:00:00Z' },
    { asOf: '' },
    { asOf: ['2026-11-14', '2026-11-15'] },
    { status: 'overdue' },
  ])('rejects %j', (query) => {
    expect(summaryQuerySchema.safeParse(query).success).toBe(false);
  });
});

describe('readingStatisticsQuerySchema', () => {
  it('accepts only an empty query', () => {
    expect(readingStatisticsQuerySchema.parse({})).toEqual({});
    for (const query of [{ asOf: '2026-11-14' }, { format: 'ebook' }, { page: '1' }]) {
      expect(readingStatisticsQuerySchema.safeParse(query).success).toBe(false);
    }
  });
});

describe('recentActivityQuerySchema', () => {
  it('defaults to 10 and accepts 1 to 20', () => {
    expect(recentActivityQuerySchema.parse({})).toEqual({ limit: 10 });
    expect(recentActivityQuerySchema.parse({ limit: '1' })).toEqual({ limit: 1 });
    expect(recentActivityQuerySchema.parse({ limit: '20' })).toEqual({ limit: 20 });
  });

  it.each([
    { limit: '0' },
    { limit: '21' },
    { limit: '-1' },
    { limit: '2.5' },
    { limit: ['1', '2'] },
    { page: '1' },
  ])('rejects %j', (query) => {
    expect(recentActivityQuerySchema.safeParse(query).success).toBe(false);
  });
});

describe('dashboard endpoints without authentication', () => {
  it.each([
    '/api/v1/dashboard/summary',
    '/api/v1/dashboard/reading-statistics',
    '/api/v1/dashboard/recent-activity',
    '/api/v1/dashboard/unknown',
  ])('GET %s returns 401 UNAUTHENTICATED without caching', async (path) => {
    const res = await request(createTestApp()).get(path);

    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toBe('Bearer');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('sends no-store for malformed bodies and CORS preflight', async () => {
    const app = createTestApp();

    const malformed = await request(app)
      .post('/api/v1/dashboard/summary')
      .set('Content-Type', 'application/json')
      .send('{"asOf": ');
    const preflight = await request(app)
      .options('/api/v1/dashboard/summary')
      .set('Origin', 'http://localhost:5173')
      .set('Access-Control-Request-Method', 'GET');

    expect(malformed.status).toBe(400);
    expect(preflight.status).toBe(204);
    expect(malformed.headers['cache-control']).toBe('no-store');
    expect(preflight.headers['cache-control']).toBe('no-store');
  });
});
