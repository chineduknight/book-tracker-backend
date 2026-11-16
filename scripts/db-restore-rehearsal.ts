import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import mongoose, { type Connection } from 'mongoose';
import { applicationModelsOn } from '../src/db/application-models.js';
import { blockingDiscrepanciesOf, inspectIndexes } from '../src/db/index-verification.js';
import { connectionOptionsFor } from '../src/db/mongo.js';
import { formatSafeError } from '../src/shared/safe-error.js';
import {
  readManifest,
  summarizeCollections,
  type BackupManifest,
} from './backup/backup-manifest.js';
import {
  BackupRefusedError,
  DatabaseToolFailedError,
  runDatabaseTool,
  sha256Of,
} from './backup/database-tools.js';
import {
  toLocalDisposableDatabaseUri,
  UnsafeDatabaseTargetError,
} from './local-database-target.js';

/*
 * Restore rehearsal; see docs/backup-and-restore.md.
 *   RESTORE_REHEARSAL_URI=mongodb://127.0.0.1:27017/book-tracker-restore-rehearsal \
 *     npm run db:restore-rehearsal -- --archive=<path to .archive.gz>
 * Restores only into an empty local database with exactly this name, then checks it read-only.
 * There is deliberately no production restore command: a real recovery restores into a new
 * database by hand, following the runbook.
 */

export const REHEARSAL_DATABASE_NAME = 'book-tracker-restore-rehearsal';
const REHEARSAL_VARIABLE = 'RESTORE_REHEARSAL_URI';
const SAMPLE_DOCUMENTS_PER_COLLECTION = 50;

function report(message: string): void {
  process.stdout.write(`[db:restore-rehearsal] ${message}\n`);
}

function archivePathFrom(argv: readonly string[]): string {
  const [argument, ...rest] = argv;
  if (!argument?.startsWith('--archive=') || rest.length > 0) {
    throw new BackupRefusedError('usage: npm run db:restore-rehearsal -- --archive=<path>');
  }
  return resolve(argument.slice('--archive='.length));
}

function rehearsalUri(): string {
  const uri = process.env[REHEARSAL_VARIABLE];
  if (!uri) throw new BackupRefusedError(`${REHEARSAL_VARIABLE} is required`);
  return toLocalDisposableDatabaseUri(uri, {
    variable: REHEARSAL_VARIABLE,
    databaseName: REHEARSAL_DATABASE_NAME,
  });
}

async function verifyArchiveIntegrity(
  archivePath: string,
  manifest: BackupManifest,
): Promise<void> {
  const { size } = await stat(archivePath);
  if (size !== manifest.bytes || (await sha256Of(archivePath)) !== manifest.sha256) {
    throw new BackupRefusedError('the archive does not match its manifest checksum');
  }
}

async function requireEmptyDatabase(connection: Connection): Promise<void> {
  const collections = await connection.db?.listCollections({}, { nameOnly: true }).toArray();
  if (collections === undefined || collections.length > 0) {
    throw new BackupRefusedError(
      `${REHEARSAL_DATABASE_NAME} is not empty; review and drop it yourself before rehearsing`,
    );
  }
}

/** Mismatches between the restored database and the manifest, by collection name. */
async function countMismatches(
  connection: Connection,
  manifest: BackupManifest,
): Promise<string[]> {
  const restored = new Map(
    (await summarizeCollections(connection)).map((summary) => [summary.name, summary]),
  );
  const mismatches: string[] = [];
  for (const expected of manifest.collections) {
    const actual = restored.get(expected.name);
    if (!actual) mismatches.push(`${expected.name}: missing`);
    else if (actual.documents !== expected.documents) {
      mismatches.push(
        `${expected.name}: ${actual.documents} documents, expected ${expected.documents}`,
      );
    } else if (actual.indexes.join(',') !== expected.indexes.join(',')) {
      mismatches.push(`${expected.name}: indexes differ from the backup`);
    }
  }
  return mismatches;
}

/** Field names (never values) that fail the current schema, or none when the document is valid. */
async function invalidFieldsOf(document: { validate(): Promise<void> }): Promise<string[]> {
  try {
    await document.validate();
    return [];
  } catch (error) {
    if (error instanceof mongoose.Error.ValidationError) return Object.keys(error.errors);
    throw error;
  }
}

/** Validates a sample of every collection against the current schemas, reporting names only. */
async function invalidSamples(connection: Connection): Promise<string[]> {
  const problems: string[] = [];
  for (const { modelName, collection } of applicationModelsOn(connection)) {
    const model = connection.model<Record<string, unknown>>(modelName);
    // Read through the driver: schema-level `select: false` fields (password hashes) must be checked too.
    const sample = await connection
      .collection(collection.collectionName)
      .find()
      .limit(SAMPLE_DOCUMENTS_PER_COLLECTION)
      .toArray();
    const invalidFields = new Set<string>();
    let invalidDocuments = 0;
    for (const document of sample) {
      const fields = await invalidFieldsOf(model.hydrate(document));
      if (fields.length > 0) invalidDocuments += 1;
      fields.forEach((field) => invalidFields.add(field));
    }
    if (invalidDocuments > 0) {
      problems.push(
        `${collection.collectionName}: ${invalidDocuments} of ${sample.length} sampled documents fail the schema (${[...invalidFields].join(', ')})`,
      );
    }
  }
  return problems;
}

async function main(): Promise<void> {
  const archivePath = archivePathFrom(process.argv.slice(2));
  const targetUri = rehearsalUri();
  const manifest = await readManifest(archivePath);
  await verifyArchiveIntegrity(archivePath, manifest);
  report(`archive of ${manifest.database} from ${manifest.createdAt} matches its checksum`);

  const connection = mongoose.createConnection(targetUri, {
    ...connectionOptionsFor({ buildIndexesOnConnect: false }),
    dbName: REHEARSAL_DATABASE_NAME,
  });
  try {
    await connection.asPromise();
    await requireEmptyDatabase(connection);

    const startedAt = performance.now();
    await runDatabaseTool('mongorestore', targetUri, [
      `--archive=${archivePath}`,
      '--gzip',
      `--nsInclude=${manifest.database}.*`,
      `--nsFrom=${manifest.database}.*`,
      `--nsTo=${REHEARSAL_DATABASE_NAME}.*`,
      '--stopOnError',
    ]);
    const restoreSeconds = (performance.now() - startedAt) / 1000;
    report(`restored into ${REHEARSAL_DATABASE_NAME} in ${restoreSeconds.toFixed(1)} s`);

    const problems = [
      ...(await countMismatches(connection, manifest)),
      ...blockingDiscrepanciesOf(await inspectIndexes(connection)).map(
        ({ collection, index, problem }) => `${collection}.${index}: ${problem}`,
      ),
      ...(await invalidSamples(connection)),
    ];
    for (const problem of problems) report(`problem: ${problem}`);
    if (problems.length > 0) {
      process.exitCode = 1;
      return;
    }
    report(
      `verified ${manifest.collections.length} collections, required indexes and sampled records`,
    );
    report(`drop ${REHEARSAL_DATABASE_NAME} when you are done reviewing it`);
  } finally {
    await connection.close();
  }
}

main().catch((error: unknown) => {
  if (error instanceof BackupRefusedError || error instanceof UnsafeDatabaseTargetError) {
    report(`refused: ${error.message}`);
  } else if (error instanceof DatabaseToolFailedError) report(`failed: ${error.message}`);
  else report(`failed: ${formatSafeError(error)}`);
  process.exitCode = 1;
});
