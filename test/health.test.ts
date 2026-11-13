import mongoose from 'mongoose';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createTestApp, mockDatabaseState } from './helpers.js';

const { ConnectionStates } = mongoose;

describe('GET /api/v1/health (liveness)', () => {
  it('returns 200 even when MongoDB is disconnected', async () => {
    mockDatabaseState(ConnectionStates.disconnected);

    const res = await request(createTestApp()).get('/api/v1/health');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toEqual({ data: { status: 'ok', timestamp: expect.any(String) } });
  });
});

describe('GET /api/v1/ready (readiness)', () => {
  it('returns 200 when MongoDB is connected', async () => {
    mockDatabaseState(ConnectionStates.connected);

    const res = await request(createTestApp()).get('/api/v1/ready');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: { status: 'ready', checks: { database: 'connected' } } });
  });

  it.each([
    ['disconnected', ConnectionStates.disconnected],
    ['connecting', ConnectionStates.connecting],
    ['disconnecting', ConnectionStates.disconnecting],
  ])('returns 503 with a safe error body when MongoDB is %s', async (_label, state) => {
    mockDatabaseState(state);

    const res = await request(createTestApp()).get('/api/v1/ready');

    expect(res.status).toBe(503);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toEqual({
      error: {
        code: 'SERVICE_UNAVAILABLE',
        message: 'Service is not ready: database is not connected',
        requestId: expect.any(String),
      },
    });
  });
});
