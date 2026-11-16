import type { Request } from 'express';
import { rateLimit, type Options } from 'express-rate-limit';
import type { Logger } from '../../config/logger.js';
import { rateLimitedError } from './auth.errors.js';
import { authenticatedUserOf } from './auth.middleware.js';
import { normalizedEmailSchema } from './auth.schema.js';

export interface RateLimitRule {
  limit: number;
  windowMs: number;
}

export interface AuthRateLimits {
  authRequestsPerIp: RateLimitRule;
  registrationsPerIp: RateLimitRule;
  failedLoginsPerIp: RateLimitRule;
  failedLoginsPerAccount: RateLimitRule;
}

const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;
const ONE_HOUR_MS = 60 * 60 * 1000;

export const DEFAULT_AUTH_RATE_LIMITS: AuthRateLimits = {
  authRequestsPerIp: { limit: 100, windowMs: FIFTEEN_MINUTES_MS },
  registrationsPerIp: { limit: 20, windowMs: ONE_HOUR_MS },
  failedLoginsPerIp: { limit: 30, windowMs: FIFTEEN_MINUTES_MS },
  failedLoginsPerAccount: { limit: 10, windowMs: FIFTEEN_MINUTES_MS },
};

const LIMITER_PROBLEM = 'Rate limiter reported a problem';

/*
 * express-rate-limit reports misconfiguration (for example X-Forwarded-For without `trust proxy`)
 * and store failures to the console with a stack by default; route them through the safe `err`
 * serializer instead.
 */
function sharedOptionsFor(logger: Logger): Partial<Options> {
  return {
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (_req, _res, next) => next(rateLimitedError()),
    logger: {
      error: (error) => logger.error({ err: error }, LIMITER_PROBLEM),
      warn: (error) => logger.warn({ err: error }, LIMITER_PROBLEM),
    },
  };
}

function loginEmailOf(req: Request): string | undefined {
  const body: unknown = req.body;
  if (typeof body !== 'object' || body === null || !('email' in body)) return undefined;
  const email = normalizedEmailSchema.safeParse(body.email);
  return email.success ? email.data : undefined;
}

export function createAuthRateLimiters(limits: AuthRateLimits, logger: Logger) {
  const sharedOptions = sharedOptionsFor(logger);
  return {
    limitAuthRequestsPerIp: rateLimit({ ...sharedOptions, ...limits.authRequestsPerIp }),
    limitRegistrationsPerIp: rateLimit({ ...sharedOptions, ...limits.registrationsPerIp }),
    limitFailedLoginsPerIp: rateLimit({
      ...sharedOptions,
      ...limits.failedLoginsPerIp,
      skipSuccessfulRequests: true,
    }),
    limitFailedLoginsPerAccount: rateLimit({
      ...sharedOptions,
      ...limits.failedLoginsPerAccount,
      skipSuccessfulRequests: true,
      skip: (req) => loginEmailOf(req) === undefined,
      keyGenerator: (req) => `account:${loginEmailOf(req) ?? ''}`,
    }),
  };
}

const ONE_MINUTE_MS = 60 * 1000;

/**
 * Throttles each signed-in reader across every private route, keyed by the authenticated user,
 * so one account cannot monopolise the single API instance. Must run after authentication.
 */
export function createReaderRateLimiter(requestsPerMinute: number, logger: Logger) {
  return rateLimit({
    ...sharedOptionsFor(logger),
    limit: requestsPerMinute,
    windowMs: ONE_MINUTE_MS,
    keyGenerator: (req) => `reader:${authenticatedUserOf(req).userId}`,
  });
}
