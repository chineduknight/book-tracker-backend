import { createUser, findUserCredentialsByNormalizedEmail } from '../users/user.service.js';
import type { UserDto } from '../users/user.dto.js';
import { ACCESS_TOKEN_LIFETIME_SECONDS, type AccessTokenService } from './access-token.js';
import type { AuthenticatedSessionDto, SessionTokensDto } from './auth.dto.js';
import { invalidCredentialsError, invalidRefreshTokenError } from './auth.errors.js';
import type { LoginRequest, RegistrationRequest } from './auth.schema.js';
import { hashPassword, verifyPassword, verifyPasswordForUnknownAccount } from './password.js';
import {
  revokeSessionByRefreshToken,
  rotateRefreshToken,
  startSession,
  type IssuedRefreshToken,
} from './session.service.js';

function secondsUntil(moment: Date): number {
  return Math.max(0, Math.floor((moment.getTime() - Date.now()) / 1000));
}

export function createAuthService(accessTokens: AccessTokenService) {
  async function issueSessionTokens(session: IssuedRefreshToken): Promise<SessionTokensDto> {
    return {
      accessToken: await accessTokens.issueAccessToken(session),
      refreshToken: session.refreshToken,
      tokenType: 'Bearer',
      expiresIn: ACCESS_TOKEN_LIFETIME_SECONDS,
      refreshExpiresIn: secondsUntil(session.sessionExpiresAt),
    };
  }

  async function signIn(user: UserDto): Promise<AuthenticatedSessionDto> {
    const session = await startSession(user.id);
    return { user, tokens: await issueSessionTokens(session) };
  }

  return {
    async registerUser({ name, email, password }: RegistrationRequest) {
      const user = await createUser({ name, email, passwordHash: await hashPassword(password) });
      return signIn(user);
    },

    async authenticateWithPassword({ email, password }: LoginRequest) {
      const credentials = await findUserCredentialsByNormalizedEmail(email);
      if (!credentials) {
        await verifyPasswordForUnknownAccount(password);
        throw invalidCredentialsError();
      }
      if (!(await verifyPassword(credentials.passwordHash, password))) {
        throw invalidCredentialsError();
      }
      return signIn(credentials.user);
    },

    async refreshSession(refreshToken: string): Promise<SessionTokensDto> {
      const rotatedSession = await rotateRefreshToken(refreshToken);
      if (!rotatedSession) throw invalidRefreshTokenError();
      return issueSessionTokens(rotatedSession);
    },

    async revokeSession(refreshToken: string): Promise<void> {
      const wasRevoked = await revokeSessionByRefreshToken(refreshToken);
      if (!wasRevoked) throw invalidRefreshTokenError();
    },
  };
}
