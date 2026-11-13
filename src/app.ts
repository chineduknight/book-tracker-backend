import cors from 'cors';
import express, { Router, type Express } from 'express';
import helmet from 'helmet';
import type { Logger } from './config/logger.js';
import { errorHandler, notFoundHandler } from './middleware/error-handler.js';
import { preventResponseCaching } from './middleware/prevent-response-caching.js';
import { REQUEST_ID_HEADER, requestLogger } from './middleware/request-logger.js';
import { createAccessTokenService } from './modules/auth/access-token.js';
import { createAuthenticationMiddleware } from './modules/auth/auth.middleware.js';
import { DEFAULT_AUTH_RATE_LIMITS, type AuthRateLimits } from './modules/auth/auth.rate-limits.js';
import { createAuthRouter } from './modules/auth/auth.routes.js';
import { healthRouter } from './modules/health/health.routes.js';

export const API_PREFIX = '/api/v1';
const AUTH_PATH = '/auth';
export const JSON_BODY_LIMIT = '100kb';

export interface AppOptions {
  logger: Logger;
  /** Exact browser origins allowed to call the API. */
  corsOrigins: readonly string[];
  accessTokenSecret: Uint8Array;
  authRateLimits?: AuthRateLimits;
}

/** Assembles the Express application. It does not listen or connect to MongoDB. */
export function createApp({
  logger,
  corsOrigins,
  accessTokenSecret,
  authRateLimits = DEFAULT_AUTH_RATE_LIMITS,
}: AppOptions): Express {
  const app = express();
  app.disable('x-powered-by');

  app.use(requestLogger(logger));
  // Before CORS and the body parser, so preflight and body-parsing errors are covered too.
  app.use(`${API_PREFIX}${AUTH_PATH}`, preventResponseCaching);
  app.use(helmet());
  app.use(
    cors({
      origin: [...corsOrigins],
      methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'],
      allowedHeaders: ['Content-Type', 'Authorization', REQUEST_ID_HEADER],
      exposedHeaders: [REQUEST_ID_HEADER],
      credentials: false,
      maxAge: 600,
    }),
  );
  app.use(express.json({ limit: JSON_BODY_LIMIT }));

  const accessTokens = createAccessTokenService(accessTokenSecret);
  const requireAuthenticatedUser = createAuthenticationMiddleware(accessTokens);

  const api = Router();
  api.use(healthRouter);
  api.use(
    AUTH_PATH,
    createAuthRouter({ accessTokens, requireAuthenticatedUser, rateLimits: authRateLimits }),
  );
  app.use(API_PREFIX, api);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
