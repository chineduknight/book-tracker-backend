import { setTimeout as delay } from 'node:timers/promises';
import type { Connection } from 'mongoose';
import type { Logger } from '../config/logger.js';
import { applicationModelsOn } from './application-models.js';
import { blockingDiscrepanciesOf, inspectIndexes } from './index-verification.js';

export interface IndexVerificationOptions {
  connection: Connection;
  logger: Logger;
  /** Aborting stops further checks (used during shutdown). */
  signal: AbortSignal;
  retryDelayMs?: number;
}

const INDEX_RECHECK_DELAY_MS = 30_000;

/**
 * Checks, read-only, that MongoDB holds every required index, rechecking until it does so an
 * operator can build missing indexes without restarting the API. Unique indexes enforce
 * invariants such as one active loan per copy, so the API must not report ready without them.
 *
 * Resolves `true` once verified, or `false` if aborted first.
 */
export async function verifyIndexesUntilComplete({
  connection,
  logger,
  signal,
  retryDelayMs = INDEX_RECHECK_DELAY_MS,
}: IndexVerificationOptions): Promise<boolean> {
  while (!signal.aborted) {
    try {
      // Development builds indexes on connect; wait for those builds before judging them.
      await Promise.allSettled(applicationModelsOn(connection).map((model) => model.init()));
      const report = await inspectIndexes(connection);
      const unexpected = report.discrepancies.filter(({ problem }) => problem === 'unexpected');
      if (unexpected.length > 0) {
        logger.warn({ indexes: unexpected }, 'MongoDB holds indexes the schemas do not define');
      }
      const blocking = blockingDiscrepanciesOf(report);
      if (blocking.length === 0) {
        logger.info('Required MongoDB indexes verified');
        return true;
      }
      logger.error(
        { indexes: blocking, retryInMs: retryDelayMs },
        'Required MongoDB indexes are missing or conflicting; the API stays not ready',
      );
    } catch (error) {
      if (signal.aborted) break;
      logger.warn({ err: error, retryInMs: retryDelayMs }, 'MongoDB index verification failed');
    }
    try {
      await delay(retryDelayMs, undefined, { signal });
    } catch {
      break; // aborted while waiting
    }
  }
  return false;
}
