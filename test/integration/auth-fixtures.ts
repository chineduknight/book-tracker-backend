import { randomBytes, randomUUID } from 'node:crypto';
import type { Express } from 'express';
import request from 'supertest';
import { expect } from 'vitest';
import type { AppOptions } from '../../src/app.js';
import type { AuthenticatedSessionDto, SessionTokensDto } from '../../src/modules/auth/auth.dto.js';
import type { AuthRateLimits } from '../../src/modules/auth/auth.rate-limits.js';
import { createTestApp } from '../helpers.js';

export interface Registration {
  name: string;
  email: string;
  password: string;
}

const UNLIMITED = { limit: 10_000, windowMs: 60_000 };

export const UNLIMITED_AUTH_RATE_LIMITS: AuthRateLimits = {
  authRequestsPerIp: UNLIMITED,
  registrationsPerIp: UNLIMITED,
  failedLoginsPerIp: UNLIMITED,
  failedLoginsPerAccount: UNLIMITED,
};

export function createAuthTestApp(overrides: Partial<AppOptions> = {}): Express {
  return createTestApp({ authRateLimits: UNLIMITED_AUTH_RATE_LIMITS, ...overrides });
}

export function disposablePassword(): string {
  return `pw-${randomBytes(18).toString('base64url')}`;
}

export function newRegistration(overrides: Partial<Registration> = {}): Registration {
  return {
    name: 'Test Reader',
    email: `reader-${randomUUID()}@example.test`,
    password: disposablePassword(),
    ...overrides,
  };
}

export async function registerReader(
  app: Express,
  registration: Registration = newRegistration(),
): Promise<AuthenticatedSessionDto> {
  const res = await request(app).post('/api/v1/auth/register').send(registration);
  expect(res.status).toBe(201);
  return (res.body as { data: AuthenticatedSessionDto }).data;
}

export function tokensFrom(res: { body: unknown }): SessionTokensDto {
  return (res.body as { data: { tokens: SessionTokensDto } }).data.tokens;
}

export function bearer(accessToken: string): string {
  return `Bearer ${accessToken}`;
}

/** Every key a response body may contain; anything else (e.g. `_id`, hashes) is a leak. */
export function collectKeys(value: unknown, keys = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    value.forEach((item) => collectKeys(item, keys));
  } else if (typeof value === 'object' && value !== null) {
    for (const [key, nested] of Object.entries(value)) {
      keys.add(key);
      collectKeys(nested, keys);
    }
  }
  return keys;
}

export const USER_DTO_KEYS = ['id', 'name', 'email', 'createdAt'];
export const SESSION_TOKENS_KEYS = [
  'accessToken',
  'refreshToken',
  'tokenType',
  'expiresIn',
  'refreshExpiresIn',
];
