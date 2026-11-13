import { pino, type DestinationStream, type Logger } from 'pino';
import type { LogLevel } from './env.js';

export type { Logger } from 'pino';

/** Paths whose values must never reach log output. */
export const REDACTED_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'res.headers["set-cookie"]',
  '*.password',
  '*.token',
  '*.accessToken',
  '*.refreshToken',
  '*.secret',
];

export function createLogger(level: LogLevel, destination?: DestinationStream): Logger {
  const options = {
    level,
    base: { service: 'book-tracker-api' },
    redact: { paths: REDACTED_PATHS, censor: '[REDACTED]' },
  };
  return destination ? pino(options, destination) : pino(options);
}
