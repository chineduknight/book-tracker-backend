import type { Connection } from 'mongoose';
import { applicationModelsOn, type ApplicationModel } from './application-models.js';

export type IndexKeys = Record<string, 1 | -1 | 'text'>;

export interface RequiredIndex {
  collection: string;
  name: string;
  keys: IndexKeys;
  options: Record<string, unknown>;
}

/**
 * - `missing`: a required index does not exist.
 * - `conflicting`: an index with the required name exists with other keys or options (for
 *   example not unique, or without its partial filter), so it does not enforce the invariant.
 * - `unexpected`: an index the schemas do not define. Never dropped automatically; reported for
 *   an operator to review.
 */
export type IndexProblem = 'missing' | 'conflicting' | 'unexpected';

export interface IndexDiscrepancy {
  collection: string;
  index: string;
  problem: IndexProblem;
}

export interface IndexReport {
  discrepancies: IndexDiscrepancy[];
}

/** The MongoDB driver's default index name, used when a schema index does not name itself. */
function defaultIndexName(keys: IndexKeys): string {
  return Object.entries(keys)
    .map(([field, direction]) => `${field}_${direction}`)
    .join('_');
}

function indexNameOf(keys: IndexKeys, options: Record<string, unknown>): string {
  return typeof options.name === 'string' ? options.name : defaultIndexName(keys);
}

function requiredIndexesOfModel(model: ApplicationModel): RequiredIndex[] {
  return model.schema.indexes().map(([keys, options]) => {
    const indexKeys = keys as IndexKeys;
    const indexOptions = options as Record<string, unknown>;
    return {
      collection: model.collection.collectionName,
      name: indexNameOf(indexKeys, indexOptions),
      keys: indexKeys,
      options: indexOptions,
    };
  });
}

/** Every index the application relies on, in model order. `_id` indexes are implicit. */
export function requiredIndexesOf(connection: Connection): RequiredIndex[] {
  return applicationModelsOn(connection).flatMap(requiredIndexesOfModel);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Mongoose types the diff as `any[]`; with `indexOptionsToCreate` each entry is [keys, options]. */
function nameOfIndexToCreate(entry: unknown): string {
  if (!Array.isArray(entry) || !isRecord(entry[0]) || !isRecord(entry[1])) {
    throw new TypeError('Unexpected index diff entry from Mongoose');
  }
  return indexNameOf(entry[0] as IndexKeys, entry[1]);
}

function nameOfIndexToDrop(entry: unknown): string {
  if (typeof entry !== 'string') throw new TypeError('Unexpected index diff entry from Mongoose');
  return entry;
}

async function discrepanciesOfModel(model: ApplicationModel): Promise<IndexDiscrepancy[]> {
  const collection = model.collection.collectionName;
  const diff = await model.diffIndexes({ indexOptionsToCreate: true });
  const absentNames = diff.toCreate.map((entry: unknown) => nameOfIndexToCreate(entry));
  const surplusNames = diff.toDrop.map((entry: unknown) => nameOfIndexToDrop(entry));
  return [
    ...absentNames.map((index) => ({
      collection,
      index,
      problem: surplusNames.includes(index) ? ('conflicting' as const) : ('missing' as const),
    })),
    ...surplusNames
      .filter((index) => !absentNames.includes(index))
      .map((index) => ({ collection, index, problem: 'unexpected' as const })),
  ];
}

/**
 * Compares the indexes MongoDB holds with the ones the schemas define. Read-only: it lists
 * indexes and never creates, changes or drops one.
 */
export async function inspectIndexes(connection: Connection): Promise<IndexReport> {
  const perModel = await Promise.all(applicationModelsOn(connection).map(discrepanciesOfModel));
  return { discrepancies: perModel.flat() };
}

/** Missing or conflicting indexes leave an invariant unenforced; unexpected ones do not. */
export function blockingDiscrepanciesOf(report: IndexReport): IndexDiscrepancy[] {
  return report.discrepancies.filter(({ problem }) => problem !== 'unexpected');
}
