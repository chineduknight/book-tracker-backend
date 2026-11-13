import type { Request, RequestHandler } from 'express';
import type { AccessTokenService } from './access-token.js';
import { unauthenticatedError } from './auth.errors.js';
import { isSessionActive, type SessionReference } from './session.service.js';

export type AuthenticatedUser = SessionReference;

const BEARER_CREDENTIALS = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i;

const authenticatedUsers = new WeakMap<Request, AuthenticatedUser>();

function bearerTokenFrom(req: Request): string | null {
  const authorizationHeaders = req.headersDistinct.authorization ?? [];
  const [authorization] = authorizationHeaders;
  if (authorizationHeaders.length !== 1 || authorization === undefined) return null;
  return BEARER_CREDENTIALS.exec(authorization)?.[1] ?? null;
}

export function createAuthenticationMiddleware(accessTokens: AccessTokenService): RequestHandler {
  return async function requireAuthenticatedUser(req, res, next) {
    const accessToken = bearerTokenFrom(req);
    const claims = accessToken ? await accessTokens.verifyAccessToken(accessToken) : null;
    if (!claims || !(await isSessionActive(claims))) {
      res.set('WWW-Authenticate', 'Bearer');
      throw unauthenticatedError();
    }
    authenticatedUsers.set(req, claims);
    next();
  };
}

export function authenticatedUserOf(req: Request): AuthenticatedUser {
  const authenticatedUser = authenticatedUsers.get(req);
  if (!authenticatedUser) {
    throw new Error('authenticatedUserOf requires requireAuthenticatedUser on the route');
  }
  return authenticatedUser;
}
