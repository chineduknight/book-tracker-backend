import request from 'supertest';
import { describe, expect, it } from 'vitest';
import {
  collectKeys,
  createAuthTestApp,
  disposablePassword,
  newRegistration,
  registerReader,
  SESSION_TOKENS_KEYS,
  USER_DTO_KEYS,
} from './auth-fixtures.js';

describe('POST /api/v1/auth/login', () => {
  it('starts a new session for valid credentials', async () => {
    const app = createAuthTestApp();
    const registration = newRegistration();
    const { user } = await registerReader(app, registration);

    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: registration.email, password: registration.password });

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.data.user).toEqual(user);
    expect(res.body.data.tokens.tokenType).toBe('Bearer');
    expect([...collectKeys(res.body)].sort()).toEqual(
      ['data', 'user', 'tokens', ...USER_DTO_KEYS, ...SESSION_TOKENS_KEYS].sort(),
    );
    expect(res.text).not.toContain(registration.password);
    expect(res.text).not.toContain('argon2');
  });

  it('responds identically to a wrong password and an unknown account', async () => {
    const app = createAuthTestApp();
    const registration = newRegistration();
    await registerReader(app, registration);

    const wrongPassword = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: registration.email, password: disposablePassword() });
    const unknownAccount = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: newRegistration().email, password: disposablePassword() });

    for (const res of [wrongPassword, unknownAccount]) {
      expect(res.status).toBe(401);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body).toEqual({
        error: {
          code: 'INVALID_CREDENTIALS',
          message: 'Email or password is incorrect',
          requestId: res.headers['x-request-id'],
        },
      });
    }
  });
});
