import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { createApp } from './app.js';
import { ConfigError, loadEnv, type Env } from './config/env.js';
import { createLogger, fatalErrorHandler } from './config/logger.js';
import {
  connectWithRetry,
  disconnectFromDatabase,
  registerDatabaseEventLogging,
} from './db/mongo.js';
import { formatSafeError } from './shared/safe-error.js';

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

async function main(): Promise<void> {
  const env = readConfig();
  if (!env) {
    process.exitCode = 1;
    return;
  }

  const logger = createLogger(env.LOG_LEVEL);
  process.on('unhandledRejection', fatalErrorHandler(logger, 'Unhandled promise rejection'));
  process.on('uncaughtException', fatalErrorHandler(logger, 'Uncaught exception'));

  const server = createServer(createApp({ logger, corsOrigins: env.CORS_ORIGIN }));
  server.listen(env.PORT);
  await once(server, 'listening');
  logger.info({ port: env.PORT, nodeEnv: env.NODE_ENV }, 'HTTP server listening');

  // Connect in the background: /health is live immediately, /ready turns 200 once connected.
  registerDatabaseEventLogging(logger);
  const stopConnecting = new AbortController();
  const connecting = connectWithRetry(env.MONGODB_URI, { logger, signal: stopConnecting.signal });

  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Shutdown started');

    const forceExit = setTimeout(() => {
      logger.error({ timeoutMs: SHUTDOWN_TIMEOUT_MS }, 'Shutdown timed out; forcing exit');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    forceExit.unref();

    try {
      stopConnecting.abort();
      await closeServer(server); // stop accepting connections; let in-flight requests finish
      await connecting; // an in-flight connection attempt settles before we disconnect
      await disconnectFromDatabase();
      logger.info('Shutdown complete');
    } catch (error) {
      logger.error({ err: error }, 'Shutdown failed');
      process.exitCode = 1;
    } finally {
      clearTimeout(forceExit);
    }
  };

  process.once('SIGTERM', (signal) => void shutdown(signal));
  process.once('SIGINT', (signal) => void shutdown(signal));
}

main().catch((error: unknown) => {
  // No logger may exist yet; print only the safe name/code (e.g. "Error (EADDRINUSE)").
  process.stderr.write(`Fatal startup error: ${formatSafeError(error)}\n`);
  process.exit(1);
});
