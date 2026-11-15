import mongoose from 'mongoose';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createTestApp } from '../helpers.js';
import { connectToTestDatabase } from './test-database.js';

describe('readiness against a real MongoDB connection', () => {
  it('stays live while the database is disconnected and is ready again after reconnecting', async () => {
    const app = createTestApp();
    expect((await request(app).get('/api/v1/ready')).status).toBe(200);

    await mongoose.disconnect();
    try {
      const liveness = await request(app).get('/api/v1/health');
      const readiness = await request(app).get('/api/v1/ready');

      expect(liveness.status).toBe(200);
      expect(readiness.status).toBe(503);
      expect(readiness.headers['cache-control']).toBe('no-store');
      expect(readiness.body).toEqual({
        error: {
          code: 'SERVICE_UNAVAILABLE',
          message: 'Service is not ready: database is not connected',
          requestId: readiness.headers['x-request-id'],
        },
      });
    } finally {
      await connectToTestDatabase();
    }

    expect((await request(app).get('/api/v1/ready')).status).toBe(200);
  });
});
