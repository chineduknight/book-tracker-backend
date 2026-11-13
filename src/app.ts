import cors from 'cors';
import express, { Router, type Express } from 'express';
import helmet from 'helmet';
import type { Logger } from './config/logger.js';
import { errorHandler, notFoundHandler } from './middleware/error-handler.js';
import { REQUEST_ID_HEADER, requestLogger } from './middleware/request-logger.js';
import { healthRouter } from './modules/health/health.routes.js';

export const API_PREFIX = '/api/v1';
export const JSON_BODY_LIMIT = '100kb';

export interface AppOptions {
  logger: Logger;
  /** Exact browser origins allowed to call the API. */
  corsOrigins: readonly string[];
}

/** Assembles the Express application. It does not listen or connect to MongoDB. */
export function createApp({ logger, corsOrigins }: AppOptions): Express {
  const app = express();
  app.disable('x-powered-by');

  app.use(requestLogger(logger));
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

  const api = Router();
  api.use(healthRouter);
  app.use(API_PREFIX, api);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
