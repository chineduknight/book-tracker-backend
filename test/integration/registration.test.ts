import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { SessionModel } from '../../src/modules/auth/session.model.js';
import { UserModel } from '../../src/modules/users/user.model.js';
import {
  collectKeys,
  createAuthTestApp,
  newRegistration,
  SESSION_TOKENS_KEYS,
  USER_DTO_KEYS,
} from './auth-fixtures.js';

const OBJECT_ID_HEX = /^[0-9a-f]{24}$/;

describe('POST /api/v1/auth/register', () => {
  it('creates an active account and session and returns only public fields', async () => {
    const registration = newRegistration({ name: '  Jane Reader  ' });

    const res = await request(createAuthTestApp()).post('/api/v1/auth/register').send(registration);

    expect(res.status).toBe(201);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toEqual({
      data: {
        user: {
          id: expect.stringMatching(OBJECT_ID_HEX),
          name: 'Jane Reader',
          email: registration.email,
          createdAt: expect.any(String),
        },
        tokens: {
          accessToken: expect.any(String),
          refreshToken: expect.any(String),
          tokenType: 'Bearer',
          expiresIn: 900,
          refreshExpiresIn: expect.any(Number),
        },
      },
    });
    expect([...collectKeys(res.body)].sort()).toEqual(
      ['data', 'user', 'tokens', ...USER_DTO_KEYS, ...SESSION_TOKENS_KEYS].sort(),
    );
    expect(res.text).not.toContain(registration.password);
    expect(res.body.data.tokens.refreshExpiresIn).toBeGreaterThan(30 * 24 * 60 * 60 - 60);
    expect(await SessionModel.countDocuments({ userId: res.body.data.user.id })).toBe(1);
  });

  it('stores an Argon2id hash with OWASP parameters and never the plaintext password', async () => {
    const registration = newRegistration();

    await request(createAuthTestApp()).post('/api/v1/auth/register').send(registration);

    const storedUser = await UserModel.findOne({ email: registration.email })
      .select('+passwordHash')
      .lean();
    expect(storedUser?.passwordHash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(JSON.stringify(storedUser)).not.toContain(registration.password);
  });

  it('normalizes the email but keeps the password exactly as supplied', async () => {
    const app = createAuthTestApp();
    const password = '  padded password with spaces  ';

    const res = await request(app)
      .post('/api/v1/auth/register')
      .send(newRegistration({ email: '  Jane.Reader@Example.COM ', password }));

    expect(res.body.data.user.email).toBe('jane.reader@example.com');
    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'JANE.READER@example.com', password });
    expect(login.status).toBe(200);
    const trimmedLogin = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'jane.reader@example.com', password: password.trim() });
    expect(trimmedLogin.status).toBe(401);
  });

  it('returns 409 CONFLICT for an already registered email regardless of case', async () => {
    const app = createAuthTestApp();
    const registration = newRegistration();
    await request(app).post('/api/v1/auth/register').send(registration);

    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ ...registration, email: registration.email.toUpperCase() });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: {
        code: 'CONFLICT',
        message: 'An account with this email already exists',
        requestId: res.headers['x-request-id'],
      },
    });
  });

  it('lets the database enforce uniqueness under concurrent registrations', async () => {
    const app = createAuthTestApp();
    const registration = newRegistration();
    const attempts = ['', ' ', '  '].map((padding, index) =>
      request(app)
        .post('/api/v1/auth/register')
        .send({
          ...registration,
          email: `${padding}${index === 1 ? registration.email.toUpperCase() : registration.email}`,
        }),
    );

    const statuses = (await Promise.all(attempts)).map((res) => res.status).sort();

    expect(statuses).toEqual([201, 409, 409]);
    expect(await UserModel.countDocuments({ email: registration.email })).toBe(1);
  });
});
