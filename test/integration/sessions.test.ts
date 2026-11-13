import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { hashRefreshToken } from '../../src/modules/auth/refresh-token.js';
import { SessionModel } from '../../src/modules/auth/session.model.js';
import { bearer, createAuthTestApp, registerReader, tokensFrom } from './auth-fixtures.js';

const INVALID_REFRESH_TOKEN_ERROR = {
  code: 'INVALID_REFRESH_TOKEN',
  message: 'Refresh token is invalid, expired or revoked',
};

function refresh(app: Parameters<typeof request>[0], refreshToken: string) {
  return request(app).post('/api/v1/auth/refresh').send({ refreshToken });
}

function logout(app: Parameters<typeof request>[0], refreshToken: string) {
  return request(app).post('/api/v1/auth/logout').send({ refreshToken });
}

describe('refresh token storage', () => {
  it('stores only a SHA-256 digest of the refresh token', async () => {
    const { tokens } = await registerReader(createAuthTestApp());

    const session = await SessionModel.findOne().lean();

    expect(session?.refreshTokenHash).toBe(hashRefreshToken(tokens.refreshToken));
    expect(JSON.stringify(session)).not.toContain(tokens.refreshToken);
    expect(Buffer.from(tokens.refreshToken, 'base64url')).toHaveLength(32);
  });
});

describe('POST /api/v1/auth/refresh', () => {
  it('rotates the refresh token and issues a new access token', async () => {
    const app = createAuthTestApp();
    const { tokens } = await registerReader(app);

    const res = await refresh(app, tokens.refreshToken);

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toEqual({
      data: {
        tokens: {
          accessToken: expect.any(String),
          refreshToken: expect.any(String),
          tokenType: 'Bearer',
          expiresIn: 900,
          refreshExpiresIn: expect.any(Number),
        },
      },
    });
    expect(tokensFrom(res).refreshToken).not.toBe(tokens.refreshToken);
    const me = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', bearer(tokensFrom(res).accessToken));
    expect(me.status).toBe(200);
  });

  it('keeps the absolute session expiry when rotating', async () => {
    const app = createAuthTestApp();
    const { tokens } = await registerReader(app);
    const { expiresAt } = (await SessionModel.findOne().lean()) ?? {};

    await refresh(app, tokens.refreshToken);

    expect((await SessionModel.findOne().lean())?.expiresAt).toEqual(expiresAt);
  });

  it('rejects a consumed refresh token and revokes its session as suspected theft', async () => {
    const app = createAuthTestApp();
    const { tokens } = await registerReader(app);
    const rotated = await refresh(app, tokens.refreshToken);

    const replay = await refresh(app, tokens.refreshToken);

    expect(replay.status).toBe(401);
    expect(replay.body.error).toMatchObject(INVALID_REFRESH_TOKEN_ERROR);
    const session = await SessionModel.findOne().lean();
    expect(session?.revocationReason).toBe('refresh_token_reuse');
    expect((await refresh(app, tokensFrom(rotated).refreshToken)).status).toBe(401);
    const me = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', bearer(tokensFrom(rotated).accessToken));
    expect(me.status).toBe(401);
  });

  it('lets at most one of several concurrent refreshes with the same token succeed', async () => {
    const app = createAuthTestApp();
    const { tokens } = await registerReader(app);

    const responses = await Promise.all(
      Array.from({ length: 5 }, () => refresh(app, tokens.refreshToken)),
    );

    const statuses = responses.map((res) => res.status).sort();
    expect(statuses).toEqual([200, 401, 401, 401, 401]);
    const session = await SessionModel.findOne().lean();
    expect(session?.consumedRefreshTokenHashes).toEqual([hashRefreshToken(tokens.refreshToken)]);
  });

  it('rejects an expired session', async () => {
    const app = createAuthTestApp();
    const { tokens } = await registerReader(app);
    await SessionModel.updateOne({}, { $set: { expiresAt: new Date(Date.now() - 1000) } });

    const res = await refresh(app, tokens.refreshToken);

    expect(res.status).toBe(401);
    expect(res.body.error).toMatchObject(INVALID_REFRESH_TOKEN_ERROR);
  });

  it('rejects an unknown token without revoking anyone else’s session', async () => {
    const app = createAuthTestApp();
    const { tokens } = await registerReader(app);

    const res = await refresh(app, 'x'.repeat(43));

    expect(res.status).toBe(401);
    expect(res.body.error).toMatchObject(INVALID_REFRESH_TOKEN_ERROR);
    expect((await refresh(app, tokens.refreshToken)).status).toBe(200);
  });
});

describe('POST /api/v1/auth/logout', () => {
  it('revokes the session so refresh and access tokens stop working immediately', async () => {
    const app = createAuthTestApp();
    const { tokens } = await registerReader(app);

    const res = await logout(app, tokens.refreshToken);

    expect(res.status).toBe(204);
    expect(res.text).toBe('');
    expect((await SessionModel.findOne().lean())?.revocationReason).toBe('logout');
    const refreshAfterLogout = await refresh(app, tokens.refreshToken);
    expect(refreshAfterLogout.status).toBe(401);
    expect(refreshAfterLogout.body.error).toMatchObject(INVALID_REFRESH_TOKEN_ERROR);
    const me = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', bearer(tokens.accessToken));
    expect(me.status).toBe(401);
    expect(me.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('rejects a repeated logout with 401 INVALID_REFRESH_TOKEN', async () => {
    const app = createAuthTestApp();
    const { tokens } = await registerReader(app);
    await logout(app, tokens.refreshToken);

    const res = await logout(app, tokens.refreshToken);

    expect(res.status).toBe(401);
    expect(res.body.error).toMatchObject(INVALID_REFRESH_TOKEN_ERROR);
  });

  it('only revokes the session that owns the presented token', async () => {
    const app = createAuthTestApp();
    const first = await registerReader(app);
    const second = await registerReader(app);

    await logout(app, first.tokens.refreshToken);

    expect((await logout(app, 'not-a-real-token')).status).toBe(401);
    expect((await refresh(app, second.tokens.refreshToken)).status).toBe(200);
  });
});
