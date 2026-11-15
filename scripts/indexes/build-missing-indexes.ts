import type { Connection } from 'mongoose';
import { applicationModelsOn } from '../../src/db/application-models.js';
import { isDuplicateKeyError } from '../../src/db/mongo.js';
import {
  blockingDiscrepanciesOf,
  inspectIndexes,
  type IndexDiscrepancy,
  type IndexReport,
} from '../../src/db/index-verification.js';
import { toSafeError, type SafeError } from '../../src/shared/safe-error.js';

export class ConflictingIndexesError extends Error {
  override readonly name = 'ConflictingIndexesError';

  constructor(readonly conflicts: IndexDiscrepancy[]) {
    super('Conflicting indexes must be resolved by an operator before missing ones are built');
  }
}

export interface IndexBuildFailure {
  collection: string;
  reason: 'existing_documents_violate_a_unique_index' | 'build_failed';
  error: SafeError;
}

export interface IndexBuildOutcome {
  failures: IndexBuildFailure[];
  report: IndexReport;
}

/**
 * Builds only indexes that are missing. Additive by construction: it never drops, hides or
 * changes an index, and refuses to start while any required index conflicts with an existing
 * one, because replacing it needs a reviewed manual decision.
 */
export async function buildMissingIndexes(connection: Connection): Promise<IndexBuildOutcome> {
  const blocking = blockingDiscrepanciesOf(await inspectIndexes(connection));
  const conflicts = blocking.filter(({ problem }) => problem === 'conflicting');
  if (conflicts.length > 0) throw new ConflictingIndexesError(conflicts);

  const collectionsMissingIndexes = new Set(blocking.map(({ collection }) => collection));
  const failures: IndexBuildFailure[] = [];
  for (const model of applicationModelsOn(connection)) {
    const collection = model.collection.collectionName;
    if (!collectionsMissingIndexes.has(collection)) continue;
    try {
      await connection.model(model.modelName).createIndexes();
    } catch (error) {
      failures.push({
        collection,
        reason: isDuplicateKeyError(error)
          ? 'existing_documents_violate_a_unique_index'
          : 'build_failed',
        error: toSafeError(error),
      });
    }
  }
  return { failures, report: await inspectIndexes(connection) };
}
