import { Router } from 'express';
import { isDatabaseConnected } from '../../db/mongo.js';
import { AppError } from '../../shared/errors.js';
import type { LivenessResponseBody, ReadinessResponseBody } from './health.dto.js';

export type NotReadyReason = 'database_disconnected' | 'indexes_unverified';

/** Answers why the API cannot serve traffic yet, or `undefined` once it can. */
export type ReadinessCheck = () => NotReadyReason | undefined;

export const requireDatabaseConnection: ReadinessCheck = () =>
  isDatabaseConnected() ? undefined : 'database_disconnected';

const NOT_READY_MESSAGES: Record<NotReadyReason, string> = {
  database_disconnected: 'Service is not ready: database is not connected',
  indexes_unverified: 'Service is not ready: required database indexes are not verified',
};

export function createHealthRouter(checkReadiness: ReadinessCheck): Router {
  const healthRouter = Router();

  /** Liveness: the process is up and serving HTTP. Deliberately independent of MongoDB. */
  healthRouter.get('/health', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.status(200).json({
      data: { status: 'ok', timestamp: new Date().toISOString() },
    } satisfies LivenessResponseBody);
  });

  /** Readiness: the API can serve traffic safely, which requires MongoDB and its indexes. */
  healthRouter.get('/ready', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    const notReadyReason = checkReadiness();
    if (notReadyReason) {
      throw new AppError(503, 'SERVICE_UNAVAILABLE', NOT_READY_MESSAGES[notReadyReason]);
    }
    res.status(200).json({
      data: { status: 'ready', checks: { database: 'connected' } },
    } satisfies ReadinessResponseBody);
  });

  return healthRouter;
}
