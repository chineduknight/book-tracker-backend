import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { SessionModel } from '../../src/modules/auth/session.model.js';
import { UserModel } from '../../src/modules/users/user.model.js';
import { bearer, createAuthTestApp, registerReader, USER_DTO_KEYS } from './auth-fixtures.js';

describe('GET /api/v1/auth/me', () => {
  it('returns the authenticated user and nothing else', async () => {
    const app = createAuthTestApp();
    const { user, tokens } = await registerReader(app);

    const res = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', bearer(tokens.accessToken));

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toEqual({ data: { user } });
    expect(Object.keys(res.body.data.user as object).sort()).toEqual([...USER_DTO_KEYS].sort());
  });

  it('isolates accounts: each token resolves only to its own user', async () => {
    const app = createAuthTestApp();
    const jane = await registerReader(app);
    const omar = await registerReader(app);

    const janeView = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', bearer(jane.tokens.accessToken));
    const omarView = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', bearer(omar.tokens.accessToken));

    expect(janeView.body.data.user.id).toBe(jane.user.id);
    expect(omarView.body.data.user.id).toBe(omar.user.id);
    expect(janeView.body.data.user.id).not.toBe(omar.user.id);
  });

  it('accepts the bearer scheme case-insensitively', async () => {
    const app = createAuthTestApp();
    const { tokens } = await registerReader(app);

    const res = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', `bearer ${tokens.accessToken}`);

    expect(res.status).toBe(200);
  });

  it('rejects two Authorization headers even when both carry a valid token', async () => {
    const app = createAuthTestApp();
    const { tokens } = await registerReader(app);

    const res = await request(app)
      .get('/api/v1/auth/me')
      .set({ Authorization: [bearer(tokens.accessToken), bearer(tokens.accessToken)] });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('rejects a refresh token presented as an access token', async () => {
    const app = createAuthTestApp();
    const { tokens } = await registerReader(app);

    const res = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', bearer(tokens.refreshToken));

    expect(res.status).toBe(401);
  });

  it.each([
    [
      'the session was revoked',
      () =>
        SessionModel.updateOne({}, { $set: { revokedAt: new Date(), revocationReason: 'logout' } }),
    ],
    [
      'the session expired',
      () => SessionModel.updateOne({}, { $set: { expiresAt: new Date(Date.now() - 1000) } }),
    ],
    ['the session no longer exists', () => SessionModel.deleteMany({})],
    ['the user no longer exists', () => UserModel.deleteMany({})],
  ])('returns 401 UNAUTHENTICATED when %s', async (_label, invalidate) => {
    const app = createAuthTestApp();
    const { tokens } = await registerReader(app);
    await invalidate();

    const res = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', bearer(tokens.accessToken));

    expect(res.status).toBe(401);
    expect(res.body).toEqual({
      error: {
        code: 'UNAUTHENTICATED',
        message: 'A valid access token is required',
        requestId: res.headers['x-request-id'],
      },
    });
  });
});
