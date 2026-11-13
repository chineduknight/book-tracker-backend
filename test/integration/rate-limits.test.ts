import request from 'supertest';
import { describe, expect, it } from 'vitest';
import {
  createAuthTestApp,
  disposablePassword,
  newRegistration,
  registerReader,
  UNLIMITED_AUTH_RATE_LIMITS,
} from './auth-fixtures.js';

const WINDOW_MS = 60_000;

describe('authentication throttling', () => {
  it('blocks an account after repeated failed logins, even with the right password', async () => {
    const app = createAuthTestApp({
      authRateLimits: {
        ...UNLIMITED_AUTH_RATE_LIMITS,
        failedLoginsPerAccount: { limit: 3, windowMs: WINDOW_MS },
      },
    });
    const victim = newRegistration();
    await registerReader(app, victim);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const res = await request(app)
        .post('/api/v1/auth/login')
        .send({ email: victim.email, password: disposablePassword() });
      expect(res.status).toBe(401);
    }
    const blocked = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: victim.email.toUpperCase(), password: victim.password });

    expect(blocked.status).toBe(429);
    expect(blocked.headers['retry-after']).toBeDefined();
    expect(blocked.body).toEqual({
      error: {
        code: 'RATE_LIMITED',
        message: 'Too many requests, try again later',
        requestId: blocked.headers['x-request-id'],
      },
    });
    const otherReader = newRegistration();
    await registerReader(app, otherReader);
    const unaffected = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: otherReader.email, password: otherReader.password });
    expect(unaffected.status).toBe(200);
  });

  it('does not count successful logins towards the account limit', async () => {
    const app = createAuthTestApp({
      authRateLimits: {
        ...UNLIMITED_AUTH_RATE_LIMITS,
        failedLoginsPerAccount: { limit: 2, windowMs: WINDOW_MS },
      },
    });
    const reader = newRegistration();
    await registerReader(app, reader);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const res = await request(app)
        .post('/api/v1/auth/login')
        .send({ email: reader.email, password: reader.password });
      expect(res.status).toBe(200);
    }
  });

  it('blocks a source address after repeated failed logins across accounts', async () => {
    const app = createAuthTestApp({
      authRateLimits: {
        ...UNLIMITED_AUTH_RATE_LIMITS,
        failedLoginsPerIp: { limit: 3, windowMs: WINDOW_MS },
      },
    });

    const statuses: number[] = [];
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const res = await request(app)
        .post('/api/v1/auth/login')
        .send({ email: newRegistration().email, password: disposablePassword() });
      statuses.push(res.status);
    }

    expect(statuses).toEqual([401, 401, 401, 429]);
  });

  it('limits registrations per source address', async () => {
    const app = createAuthTestApp({
      authRateLimits: {
        ...UNLIMITED_AUTH_RATE_LIMITS,
        registrationsPerIp: { limit: 2, windowMs: WINDOW_MS },
      },
    });

    const statuses: number[] = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const res = await request(app).post('/api/v1/auth/register').send(newRegistration());
      statuses.push(res.status);
    }

    expect(statuses).toEqual([201, 201, 429]);
  });

  it('limits refresh and logout attempts per source address', async () => {
    const app = createAuthTestApp({
      authRateLimits: {
        ...UNLIMITED_AUTH_RATE_LIMITS,
        authRequestsPerIp: { limit: 3, windowMs: WINDOW_MS },
      },
    });

    const statuses: number[] = [];
    for (const path of ['refresh', 'logout', 'refresh', 'logout']) {
      const res = await request(app).post(`/api/v1/auth/${path}`).send({ refreshToken: 'guess' });
      statuses.push(res.status);
    }

    expect(statuses).toEqual([401, 401, 401, 429]);
  });
});
