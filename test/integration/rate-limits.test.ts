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

  /*
   * `trust proxy` is off until a hosting network is defined (PR #14), so the limiters key on the
   * socket address. A client must not be able to escape its bucket by inventing forwarded-for
   * addresses.
   */
  it('ignores spoofed X-Forwarded-For addresses when counting failed logins', async () => {
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
        .set('X-Forwarded-For', `203.0.113.${attempt + 1}`)
        .set('Forwarded', `for=198.51.100.${attempt + 1}`)
        .set('X-Real-IP', `192.0.2.${attempt + 1}`)
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

  it('limits logout attempts per source address, with the other sign-in requests', async () => {
    const app = createAuthTestApp({
      authRateLimits: {
        ...UNLIMITED_AUTH_RATE_LIMITS,
        authRequestsPerIp: { limit: 3, windowMs: WINDOW_MS },
      },
    });

    const statuses: number[] = [];
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const res = await request(app).post('/api/v1/auth/logout').send({ refreshToken: 'guess' });
      statuses.push(res.status);
    }

    expect(statuses).toEqual([401, 401, 401, 429]);
  });

  it('gives refreshes their own allowance, so they never use up sign-ins', async () => {
    const app = createAuthTestApp({
      authRateLimits: {
        ...UNLIMITED_AUTH_RATE_LIMITS,
        authRequestsPerIp: { limit: 2, windowMs: WINDOW_MS },
        refreshesPerIp: { limit: 3, windowMs: WINDOW_MS },
      },
    });

    const refreshStatuses: number[] = [];
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const res = await request(app).post('/api/v1/auth/refresh').send({ refreshToken: 'guess' });
      refreshStatuses.push(res.status);
    }
    expect(refreshStatuses).toEqual([401, 401, 401, 429]);

    const loginStatuses: number[] = [];
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const res = await request(app)
        .post('/api/v1/auth/login')
        .send({ email: 'nobody@example.test', password: disposablePassword() });
      loginStatuses.push(res.status);
    }
    expect(loginStatuses).toEqual([401, 401]);
  });
});
