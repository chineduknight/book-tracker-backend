import { randomBytes } from 'node:crypto';
import { SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import {
  ACCESS_TOKEN_AUDIENCE,
  ACCESS_TOKEN_ISSUER,
  createAccessTokenService,
} from '../src/modules/auth/access-token.js';
import { generateRefreshToken } from '../src/modules/auth/refresh-token.js';

const signingSecret = randomBytes(32);
const accessTokens = createAccessTokenService(signingSecret);
const claims = { userId: '64b7f0c2a1b2c3d4e5f60718', sessionId: '64b7f0c2a1b2c3d4e5f60719' };

interface ForgedTokenOptions {
  algorithm?: string;
  type?: string;
  issuer?: string;
  audience?: string;
  subject?: string;
  sessionId?: string | undefined;
  issuedAt?: number;
  expiresAt?: number;
  secret?: Uint8Array;
}

function nowInSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function forgeAccessToken(options: ForgedTokenOptions = {}): Promise<string> {
  const payload = 'sessionId' in options ? { sid: options.sessionId } : { sid: claims.sessionId };
  return new SignJWT(payload)
    .setProtectedHeader({ alg: options.algorithm ?? 'HS256', typ: options.type ?? 'at+jwt' })
    .setSubject(options.subject ?? claims.userId)
    .setIssuer(options.issuer ?? ACCESS_TOKEN_ISSUER)
    .setAudience(options.audience ?? ACCESS_TOKEN_AUDIENCE)
    .setIssuedAt(options.issuedAt ?? nowInSeconds())
    .setExpirationTime(options.expiresAt ?? nowInSeconds() + 60)
    .sign(options.secret ?? signingSecret);
}

function unsignedToken(header: object, payload: object): string {
  const encode = (part: object) => Buffer.from(JSON.stringify(part)).toString('base64url');
  return `${encode(header)}.${encode(payload)}.`;
}

describe('access tokens', () => {
  it('round-trips the user and session identifiers', async () => {
    const accessToken = await accessTokens.issueAccessToken(claims);

    await expect(accessTokens.verifyAccessToken(accessToken)).resolves.toEqual(claims);
  });

  it('contains only identifiers and standard claims', async () => {
    const accessToken = await accessTokens.issueAccessToken(claims);
    const [header, payload] = accessToken
      .split('.')
      .slice(0, 2)
      .map((part) => JSON.parse(Buffer.from(part, 'base64url').toString()) as object);

    expect(header).toEqual({ alg: 'HS256', typ: 'at+jwt' });
    expect(Object.keys(payload ?? {}).sort()).toEqual(['aud', 'exp', 'iat', 'iss', 'sid', 'sub']);
  });

  it('expires after 15 minutes', async () => {
    const accessToken = await accessTokens.issueAccessToken(claims);
    const payload = JSON.parse(
      Buffer.from(accessToken.split('.')[1] ?? '', 'base64url').toString(),
    ) as { iat: number; exp: number };

    expect(payload.exp - payload.iat).toBe(15 * 60);
  });

  it.each<[string, ForgedTokenOptions]>([
    ['expired', { issuedAt: nowInSeconds() - 3600, expiresAt: nowInSeconds() - 1800 }],
    ['signed with another secret', { secret: randomBytes(32) }],
    ['from another issuer', { issuer: 'someone-else' }],
    ['for another audience', { audience: 'someone-else' }],
    ['signed with a non-allowlisted algorithm', { algorithm: 'HS512' }],
    ['of the wrong token type', { type: 'JWT' }],
    ['missing the session identifier', { sessionId: undefined }],
    ['carrying a malformed subject', { subject: 'jane@example.com' }],
    ['carrying a malformed session identifier', { sessionId: 'session-1' }],
  ])('rejects a token %s', async (_label, options) => {
    await expect(accessTokens.verifyAccessToken(await forgeAccessToken(options))).resolves.toBe(
      null,
    );
  });

  it('rejects unsigned alg "none" tokens', async () => {
    const token = unsignedToken(
      { alg: 'none', typ: 'at+jwt' },
      {
        sub: claims.userId,
        sid: claims.sessionId,
        iss: ACCESS_TOKEN_ISSUER,
        aud: ACCESS_TOKEN_AUDIENCE,
        iat: nowInSeconds(),
        exp: nowInSeconds() + 60,
      },
    );

    await expect(accessTokens.verifyAccessToken(token)).resolves.toBe(null);
  });

  it.each([
    ['a refresh token', generateRefreshToken()],
    ['garbage', 'not.a.jwt'],
    ['an empty string', ''],
  ])('rejects %s', async (_label, token) => {
    await expect(accessTokens.verifyAccessToken(token)).resolves.toBe(null);
  });
});
