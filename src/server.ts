import { once } from 'node:events';
import type { Server } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import mongoose from 'mongoose';
import { createApp } from './app.js';
import { ConfigError, loadEnv, type Env } from './config/env.js';
import { createLogger, fatalErrorHandler, type Logger } from './config/logger.js';
import { verifyIndexesUntilComplete } from './db/index-readiness.js';
import {
  connectWithRetry,
  disconnectFromDatabase,
  isDatabaseConnected,
  registerDatabaseEventLogging,
} from './db/mongo.js';
import { createHttpServer } from './http-server.js';
import type { ReadinessCheck } from './modules/health/health.routes.js';
import { formatSafeError } from './shared/safe-error.js';

/** In-flight requests get this long to finish after a shutdown signal. */
const SHUTDOWN_DRAIN_MS = 8_000;
/**
 * `server.close()` only closes connections idle at that moment; a keep-alive connection whose
 * request finishes later would otherwise stay open until the drain period ends.
 */
const IDLE_CONNECTION_SWEEP_MS = 100;
/** Backstop: exit even if closing connections or disconnecting MongoDB hangs. */
const SHUTDOWN_TIMEOUT_MS = 10_000;

function readConfig(): Env | undefined {
  try {
    return loadEnv();
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`${error.message}\n`);
      return undefined;
    }
    throw error;
  }
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

/**
 * Stops accepting connections, closes idle keep-alive connections and lets in-flight requests
 * finish for up to the drain period; connections still open after it are closed.
 */
async function stopServingHttp(server: Server, logger: Logger): Promise<void> {
  const closed = closeServer(server);
  server.closeIdleConnections();
  const idleConnectionSweep = setInterval(
    () => server.closeIdleConnections(),
    IDLE_CONNECTION_SWEEP_MS,
  );
  const drainPeriod = new AbortController();
  const drained = await Promise.race([
    closed.then(() => true),
    delay(SHUTDOWN_DRAIN_MS, false, { signal: drainPeriod.signal }),
  ]);
  drainPeriod.abort();
  clearInterval(idleConnectionSweep);
  if (!drained) {
    logger.warn({ drainMs: SHUTDOWN_DRAIN_MS }, 'Requests still open after draining; closing them');
    server.closeAllConnections();
    await closed;
  }
}

function logRequestLimits(env: Env, logger: Logger): void {
  logger.info(
    {
      trustProxyHops: env.TRUST_PROXY_HOPS,
      readerRequestsPerMinute: env.READER_REQUESTS_PER_MINUTE ?? 'off',
      rateLimitStore: 'memory',
    },
    'Rate limits are held in this process: run exactly one API instance',
  );
}

async function main(): Promise<void> {
  const env = readConfig();
  if (!env) {
    process.exitCode = 1;
    return;
  }

  const logger = createLogger(env.LOG_LEVEL);
  process.on('unhandledRejection', fatalErrorHandler(logger, 'Unhandled promise rejection'));
  process.on('uncaughtException', fatalErrorHandler(logger, 'Uncaught exception'));

  let indexesVerified = false;
  const readiness: ReadinessCheck = () => {
    if (!isDatabaseConnected()) return 'database_disconnected';
    return indexesVerified ? undefined : 'indexes_unverified';
  };

  const server = createHttpServer(
    createApp({
      logger,
      corsOrigins: env.CORS_ORIGIN,
      accessTokenSecret: env.JWT_ACCESS_TOKEN_SECRET,
      trustProxyHops: env.TRUST_PROXY_HOPS,
      readerRequestsPerMinute: env.READER_REQUESTS_PER_MINUTE,
      readiness,
    }),
  );
  server.listen(env.PORT);
  await once(server, 'listening');
  logger.info({ port: env.PORT, nodeEnv: env.NODE_ENV }, 'HTTP server listening');
  logRequestLimits(env, logger);

  // Connect in the background: /health is live immediately, /ready turns 200 once connected and
  // every required index is verified.
  registerDatabaseEventLogging(logger);
  const stopDatabaseWork = new AbortController();
  const preparingDatabase = connectWithRetry(env.MONGODB_URI, {
    logger,
    signal: stopDatabaseWork.signal,
    buildIndexesOnConnect: env.NODE_ENV !== 'production',
  }).then(async (connected) => {
    if (!connected) return;
    indexesVerified = await verifyIndexesUntilComplete({
      connection: mongoose.connection,
      logger,
      signal: stopDatabaseWork.signal,
    });
  });

  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) {
      logger.warn({ signal }, 'Second shutdown signal; exiting immediately');
      process.exit(1);
    }
    shuttingDown = true;
    logger.info({ signal }, 'Shutdown started');

    const forceExit = setTimeout(() => {
      logger.error({ timeoutMs: SHUTDOWN_TIMEOUT_MS }, 'Shutdown timed out; forcing exit');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    forceExit.unref();

    try {
      stopDatabaseWork.abort();
      await stopServingHttp(server, logger);
      await preparingDatabase; // a pending connection attempt settles before we disconnect
      await disconnectFromDatabase();
      logger.info('Shutdown complete');
    } catch (error) {
      logger.error({ err: error }, 'Shutdown failed');
      process.exitCode = 1;
    } finally {
      clearTimeout(forceExit);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((error: unknown) => {
  // No logger may exist yet; print only the safe name/code (e.g. "Error (EADDRINUSE)").
  process.stderr.write(`Fatal startup error: ${formatSafeError(error)}\n`);
  process.exit(1);
});
