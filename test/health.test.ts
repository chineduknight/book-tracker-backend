import mongoose from 'mongoose';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import type {
  LivenessResponseBody,
  ReadinessResponseBody,
} from '../src/modules/health/health.dto.js';
import type { ErrorResponseBody } from '../src/shared/api-response.js';
import { createTestApp, mockDatabaseState } from './helpers.js';

const { ConnectionStates } = mongoose;

describe('GET /api/v1/health (liveness)', () => {
  it('returns 200 even when MongoDB is disconnected', async () => {
    mockDatabaseState(ConnectionStates.disconnected);

    const res = await request(createTestApp()).get('/api/v1/health');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.headers['cache-control']).toBe('no-store');
    const expectedBody: LivenessResponseBody = {
      data: { status: 'ok', timestamp: expect.any(String) },
    };
    expect(res.body).toEqual(expectedBody);
  });

  it('reports the timestamp as an ISO 8601 UTC string', async () => {
    const res = await request(createTestApp()).get('/api/v1/health');

    const { timestamp } = (res.body as LivenessResponseBody).data;
    expect(new Date(timestamp).toISOString()).toBe(timestamp);
  });

  it('answers HEAD with the same status and no body', async () => {
    const res = await request(createTestApp()).head('/api/v1/health');

    expect(res.status).toBe(200);
    expect(res.text).toBeUndefined();
  });
});

describe('GET /api/v1/ready (readiness)', () => {
  it('returns 200 when MongoDB is connected', async () => {
    mockDatabaseState(ConnectionStates.connected);

    const res = await request(createTestApp()).get('/api/v1/ready');

    expect(res.status).toBe(200);
    const expectedBody: ReadinessResponseBody = {
      data: { status: 'ready', checks: { database: 'connected' } },
    };
    expect(res.body).toEqual(expectedBody);
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
    const expectedBody: ErrorResponseBody = {
      error: {
        code: 'SERVICE_UNAVAILABLE',
        message: 'Service is not ready: database is not connected',
        requestId: expect.any(String),
      },
    };
    expect(res.body).toEqual(expectedBody);
  });

  it('answers HEAD with 503 and no body when MongoDB is disconnected', async () => {
    mockDatabaseState(ConnectionStates.disconnected);

    const res = await request(createTestApp()).head('/api/v1/ready');

    expect(res.status).toBe(503);
    expect(res.text).toBeUndefined();
  });
});
