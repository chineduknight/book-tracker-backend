import { errors, jwtVerify, SignJWT } from 'jose';

export const ACCESS_TOKEN_LIFETIME_SECONDS = 15 * 60;
export const ACCESS_TOKEN_ISSUER = 'book-tracker-api';
export const ACCESS_TOKEN_AUDIENCE = 'book-tracker-api';
const ACCESS_TOKEN_ALGORITHM = 'HS256';
const ACCESS_TOKEN_TYPE = 'at+jwt';

const OBJECT_ID_HEX = /^[0-9a-f]{24}$/;

export interface AccessTokenClaims {
  userId: string;
  sessionId: string;
}

export interface AccessTokenService {
  issueAccessToken(claims: AccessTokenClaims): Promise<string>;
  verifyAccessToken(accessToken: string): Promise<AccessTokenClaims | null>;
}

function isObjectIdHex(value: unknown): value is string {
  return typeof value === 'string' && OBJECT_ID_HEX.test(value);
}

export function createAccessTokenService(signingSecret: Uint8Array): AccessTokenService {
  return {
    issueAccessToken({ userId, sessionId }) {
      return new SignJWT({ sid: sessionId })
        .setProtectedHeader({ alg: ACCESS_TOKEN_ALGORITHM, typ: ACCESS_TOKEN_TYPE })
        .setSubject(userId)
        .setIssuer(ACCESS_TOKEN_ISSUER)
        .setAudience(ACCESS_TOKEN_AUDIENCE)
        .setIssuedAt()
        .setExpirationTime(`${ACCESS_TOKEN_LIFETIME_SECONDS}s`)
        .sign(signingSecret);
    },

    async verifyAccessToken(accessToken) {
      try {
        const { payload } = await jwtVerify(accessToken, signingSecret, {
          algorithms: [ACCESS_TOKEN_ALGORITHM],
          issuer: ACCESS_TOKEN_ISSUER,
          audience: ACCESS_TOKEN_AUDIENCE,
          typ: ACCESS_TOKEN_TYPE,
          requiredClaims: ['sub', 'sid', 'iat', 'exp'],
        });
        if (!isObjectIdHex(payload.sub) || !isObjectIdHex(payload.sid)) return null;
        return { userId: payload.sub, sessionId: payload.sid };
      } catch (error) {
        if (error instanceof errors.JOSEError) return null;
        throw error;
      }
    },
  };
}
