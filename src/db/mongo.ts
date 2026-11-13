import { setTimeout as delay } from 'node:timers/promises';
import mongoose from 'mongoose';
import type { Logger } from '../config/logger.js';

const SERVER_SELECTION_TIMEOUT_MS = 5_000;

/** Readiness is true only while the default Mongoose connection is fully connected. */
export function isDatabaseConnected(): boolean {
  return mongoose.connection.readyState === mongoose.ConnectionStates.connected;
}

/** Driver errors can be verbose; only log the error class and message, never the URI. */
function describeError(error: unknown): { name: string; message: string } {
  return error instanceof Error
    ? { name: error.name, message: error.message }
    : { name: 'UnknownError', message: String(error) };
}

export function registerDatabaseEventLogging(logger: Logger): void {
  const { connection } = mongoose;
  connection.on('connected', () => logger.info('MongoDB connected'));
  connection.on('disconnected', () => logger.warn('MongoDB disconnected'));
  connection.on('reconnected', () => logger.info('MongoDB reconnected'));
  connection.on('error', (error: unknown) =>
    logger.error({ err: describeError(error) }, 'MongoDB connection error'),
  );
}

export interface ConnectOptions {
  logger: Logger;
  /** Aborting stops further retries (used during shutdown). */
  signal: AbortSignal;
  retryDelayMs?: number;
}

/**
 * Connects the default Mongoose connection. The initial connection is retried until it
 * succeeds or the signal is aborted, so the HTTP server can stay live (and report "not ready")
 * while MongoDB is unavailable. After the first successful connection the driver handles
 * reconnects itself.
 *
 * Resolves `true` once connected, or `false` if aborted first.
 */
export async function connectWithRetry(uri: string, options: ConnectOptions): Promise<boolean> {
  const { logger, signal, retryDelayMs = 5_000 } = options;
  mongoose.set('strictQuery', true);

  for (let attempt = 1; !signal.aborted; attempt += 1) {
    try {
      await mongoose.connect(uri, { serverSelectionTimeoutMS: SERVER_SELECTION_TIMEOUT_MS });
      return true;
    } catch (error) {
      if (signal.aborted) break;
      logger.warn(
        { attempt, retryInMs: retryDelayMs, err: describeError(error) },
        'MongoDB connection attempt failed',
      );
      try {
        await delay(retryDelayMs, undefined, { signal });
      } catch {
        break; // aborted while waiting
      }
    }
  }
  return false;
}

export async function disconnectFromDatabase(): Promise<void> {
  await mongoose.disconnect();
}
