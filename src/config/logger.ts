import { pino, type DestinationStream, type Logger } from 'pino';
import { toSafeError } from '../shared/safe-error.js';
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

/**
 * Serializer for the `err` key. Always log errors as `logger.x({ err }, msg)` or
 * `logger.x(err, msg)`; both go through this allowlist. Field redaction cannot catch secrets
 * embedded inside an error message or stack, so those are never logged.
 */
export const errorSerializer = toSafeError;

export function createLogger(level: LogLevel, destination?: DestinationStream): Logger {
  const options = {
    level,
    base: { service: 'book-tracker-api' },
    redact: { paths: REDACTED_PATHS, censor: '[REDACTED]' },
    serializers: { err: errorSerializer },
  };
  return destination ? pino(options, destination) : pino(options);
}

/** Handler for `uncaughtException` / `unhandledRejection`: log safely, then exit with code 1. */
export function fatalErrorHandler(
  logger: Logger,
  message: string,
  exit: (code: number) => void = (code) => process.exit(code),
): (error: unknown) => void {
  return (error) => {
    logger.fatal({ err: error }, message);
    exit(1);
  };
}
