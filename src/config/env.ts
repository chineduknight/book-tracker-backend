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
const WHOLE_NUMBER = /^(0|[1-9][0-9]*)$/;
const MINIMUM_SECRET_BYTES = 32;
const MINIMUM_DISTINCT_SECRET_BYTES = 16;
export const MAXIMUM_TRUSTED_PROXY_HOPS = 3;

/** Variables of destructive local tooling; a deployed API must never be able to see them. */
const LOCAL_TOOLING_VARIABLES = ['MONGODB_TEST_URI', 'MONGODB_SMOKE_URI', 'RESTORE_REHEARSAL_URI'];

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
  TRUST_PROXY_HOPS: z
    .string()
    .regex(WHOLE_NUMBER, 'must be a whole number of proxy hops such as 0 or 1 (not true or false)')
    .default('0')
    .transform(Number)
    .pipe(z.number().max(MAXIMUM_TRUSTED_PROXY_HOPS, 'must be at most 3')),
  READER_REQUESTS_PER_MINUTE: z
    .string()
    .regex(WHOLE_NUMBER, 'must be a whole number of requests')
    .transform(Number)
    .pipe(z.number().min(1, 'must be at least 1').max(10_000, 'must be at most 10000'))
    .optional(),
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

interface ConfigProblem {
  variable: string;
  rule: string;
}

function productionProblemsOf(env: Env, source: NodeJS.ProcessEnv): ConfigProblem[] {
  if (env.NODE_ENV !== 'production') return [];
  return [
    ...(env.CORS_ORIGIN.some((origin) => !origin.startsWith('https://'))
      ? [{ variable: 'CORS_ORIGIN', rule: 'must list only https:// origins in production' }]
      : []),
    ...LOCAL_TOOLING_VARIABLES.filter((variable) => source[variable] !== undefined).map(
      (variable) => ({ variable, rule: 'must not be set in production' }),
    ),
  ];
}

function toConfigError(problems: readonly ConfigProblem[]): ConfigError {
  const lines = problems.map(({ variable, rule }) => `  - ${variable || '(environment)'}: ${rule}`);
  return new ConfigError(`Invalid environment configuration:\n${lines.join('\n')}`);
}

/**
 * Validates environment variables. Error messages only name the offending variable and the
 * rule it broke; input values are never echoed, so secrets such as MONGODB_URI stay private.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    throw toConfigError(
      result.error.issues.map((issue) => ({
        variable: issue.path.filter((part) => typeof part === 'string').join('.'),
        rule: issue.message,
      })),
    );
  }

  const productionProblems = productionProblemsOf(result.data, source);
  if (productionProblems.length > 0) throw toConfigError(productionProblems);
  return result.data;
}
