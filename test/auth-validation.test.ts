import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createTestApp } from './helpers.js';

const SUPPLIED_PASSWORD = 'tiny-secret';

describe('auth request validation', () => {
  it('rejects invalid registrations with field details and no supplied values', async () => {
    const res = await request(createTestApp())
      .post('/api/v1/auth/register')
      .send({ name: '   ', email: 'not-an-email', password: SUPPLIED_PASSWORD });

    expect(res.status).toBe(400);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.error).toMatchObject({
      code: 'VALIDATION_ERROR',
      message: 'The request contains invalid fields',
      requestId: res.headers['x-request-id'],
    });
    const details = res.body.error.details as { field: string }[];
    expect(details.map((detail) => detail.field)).toEqual(['name', 'email', 'password']);
    expect(res.text).not.toContain(SUPPLIED_PASSWORD);
    expect(res.text).not.toContain('not-an-email');
  });

  it.each(['role', 'ownerId', 'isAdmin'])('rejects the unknown field %s', async (field) => {
    const res = await request(createTestApp())
      .post('/api/v1/auth/register')
      .send({
        name: 'Jane Reader',
        email: 'jane@example.com',
        password: 'a-long-enough-password',
        [field]: 'admin',
      });

    expect(res.status).toBe(400);
    expect(res.body.error.details).toEqual([{ field, message: 'Unknown field' }]);
  });

  it.each([
    ['too short', 'p'.repeat(11)],
    ['too long', 'p'.repeat(129)],
  ])('rejects a registration password that is %s', async (_label, password) => {
    const res = await request(createTestApp())
      .post('/api/v1/auth/register')
      .send({ name: 'Jane Reader', email: 'jane@example.com', password });

    expect(res.status).toBe(400);
    expect(res.body.error.details).toEqual([{ field: 'password', message: expect.any(String) }]);
  });

  it('rejects a request without a JSON body', async () => {
    const res = await request(createTestApp()).post('/api/v1/auth/login');

    expect(res.status).toBe(400);
    expect(res.body.error.details).toEqual([{ field: 'body', message: expect.any(String) }]);
  });

  it.each(['/api/v1/auth/refresh', '/api/v1/auth/logout'])(
    'requires a refresh token on %s',
    async (path) => {
      const res = await request(createTestApp()).post(path).send({});

      expect(res.status).toBe(400);
      expect(res.body.error.details).toEqual([
        { field: 'refreshToken', message: expect.any(String) },
      ]);
    },
  );
});

describe('GET /api/v1/auth/me without valid credentials', () => {
  it.each([
    ['missing', undefined],
    ['using another scheme', 'Basic amFuZTpzZWNyZXQ='],
    ['without a token', 'Bearer'],
    ['with extra parts', 'Bearer a.b.c d.e.f'],
    ['not a JWT', 'Bearer opaque-token'],
    ['an invalid JWT', 'Bearer aaa.bbb.ccc'],
  ])('returns 401 UNAUTHENTICATED when the Authorization header is %s', async (_label, header) => {
    const pending = request(createTestApp()).get('/api/v1/auth/me');
    const res = await (header === undefined ? pending : pending.set('Authorization', header));

    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toBe('Bearer');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toEqual({
      error: {
        code: 'UNAUTHENTICATED',
        message: 'A valid access token is required',
        requestId: res.headers['x-request-id'],
      },
    });
  });
});
