import { Router } from 'express';
import { isDatabaseConnected } from '../../db/mongo.js';
import { AppError } from '../../shared/errors.js';

export const healthRouter = Router();

/** Liveness: the process is up and serving HTTP. Deliberately independent of MongoDB. */
healthRouter.get('/health', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.status(200).json({ data: { status: 'ok', timestamp: new Date().toISOString() } });
});

/** Readiness: the API can serve traffic, which requires a live MongoDB connection. */
healthRouter.get('/ready', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!isDatabaseConnected()) {
    throw new AppError(
      503,
      'SERVICE_UNAVAILABLE',
      'Service is not ready: database is not connected',
    );
  }
  res.status(200).json({ data: { status: 'ready', checks: { database: 'connected' } } });
});
