import { Router, type RequestHandler } from 'express';
import { parseRequestBody } from '../../shared/request-validation.js';
import { findUserById } from '../users/user.service.js';
import type { AccessTokenService } from './access-token.js';
import type {
  AuthenticatedSessionResponseBody,
  CurrentUserResponseBody,
  RefreshedSessionResponseBody,
} from './auth.dto.js';
import { unauthenticatedError } from './auth.errors.js';
import { authenticatedUserOf } from './auth.middleware.js';
import { createAuthRateLimiters, type AuthRateLimits } from './auth.rate-limits.js';
import {
  loginRequestSchema,
  refreshTokenRequestSchema,
  registrationRequestSchema,
} from './auth.schema.js';
import { createAuthService } from './auth.service.js';

export interface AuthRouterDependencies {
  accessTokens: AccessTokenService;
  requireAuthenticatedUser: RequestHandler;
  rateLimits: AuthRateLimits;
}

const preventResponseCaching: RequestHandler = (_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
};

export function createAuthRouter({
  accessTokens,
  requireAuthenticatedUser,
  rateLimits,
}: AuthRouterDependencies): Router {
  const authService = createAuthService(accessTokens);
  const limiters = createAuthRateLimiters(rateLimits);
  const authRouter = Router();

  authRouter.use(preventResponseCaching);

  authRouter.post(
    '/register',
    limiters.limitAuthRequestsPerIp,
    limiters.limitRegistrationsPerIp,
    async (req, res) => {
      const registration = parseRequestBody(registrationRequestSchema, req.body);
      const session = await authService.registerUser(registration);
      res.status(201).json({ data: session } satisfies AuthenticatedSessionResponseBody);
    },
  );

  authRouter.post(
    '/login',
    limiters.limitAuthRequestsPerIp,
    limiters.limitFailedLoginsPerIp,
    limiters.limitFailedLoginsPerAccount,
    async (req, res) => {
      const credentials = parseRequestBody(loginRequestSchema, req.body);
      const session = await authService.authenticateWithPassword(credentials);
      res.status(200).json({ data: session } satisfies AuthenticatedSessionResponseBody);
    },
  );

  authRouter.post('/refresh', limiters.limitAuthRequestsPerIp, async (req, res) => {
    const { refreshToken } = parseRequestBody(refreshTokenRequestSchema, req.body);
    const tokens = await authService.refreshSession(refreshToken);
    res.status(200).json({ data: { tokens } } satisfies RefreshedSessionResponseBody);
  });

  authRouter.post('/logout', limiters.limitAuthRequestsPerIp, async (req, res) => {
    const { refreshToken } = parseRequestBody(refreshTokenRequestSchema, req.body);
    await authService.revokeSession(refreshToken);
    res.status(204).end();
  });

  authRouter.get('/me', requireAuthenticatedUser, async (req, res) => {
    const { userId } = authenticatedUserOf(req);
    const user = await findUserById(userId);
    if (!user) throw unauthenticatedError();
    res.status(200).json({ data: { user } } satisfies CurrentUserResponseBody);
  });

  return authRouter;
}
