import { z } from 'zod';

export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

function isHttpOrigin(value: string): boolean {
  if (value.includes('*')) return false;
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.origin === value;
  } catch {
    return false;
  }
}

const BASE64URL = /^[A-Za-z0-9_-]+$/;
const MINIMUM_SECRET_BYTES = 32;
const MINIMUM_DISTINCT_SECRET_BYTES = 16;

function looksRandomlyGenerated(secret: Buffer): boolean {
  return new Set(secret).size >= MINIMUM_DISTINCT_SECRET_BYTES;
}

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  MONGODB_URI: z
    .string({ error: 'is required' })
    .trim()
    .min(1, 'is required')
    .refine(
      (value) => value.startsWith('mongodb://') || value.startsWith('mongodb+srv://'),
      'must start with mongodb:// or mongodb+srv://',
    ),
  CORS_ORIGIN: z
    .string()
    .default('http://localhost:5173')
    .transform((value) =>
      value
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean),
    )
    .pipe(
      z
        .array(
          z
            .string()
            .refine(
              isHttpOrigin,
              'each entry must be an exact http(s) origin such as http://localhost:5173 (no wildcards, paths or trailing slashes)',
            ),
        )
        .min(1, 'must list at least one origin'),
    ),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
  JWT_ACCESS_TOKEN_SECRET: z
    .string({ error: 'is required' })
    .trim()
    .min(1, 'is required')
    .regex(BASE64URL, 'must be base64url-encoded')
    .transform((encoded) => Buffer.from(encoded, 'base64url'))
    .refine(
      (secret) => secret.length >= MINIMUM_SECRET_BYTES,
      'must decode to at least 32 bytes (256 bits)',
    )
    .refine(looksRandomlyGenerated, 'must be randomly generated'),
});

export type Env = z.infer<typeof envSchema>;

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

/**
 * Validates environment variables. Error messages only name the offending variable and the
 * rule it broke; input values are never echoed, so secrets such as MONGODB_URI stay private.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = envSchema.safeParse(source);
  if (result.success) return result.data;

  const problems = result.error.issues.map((issue) => {
    const variable = issue.path.filter((part) => typeof part === 'string').join('.');
    return `  - ${variable || '(environment)'}: ${issue.message}`;
  });
  throw new ConfigError(`Invalid environment configuration:\n${problems.join('\n')}`);
}
