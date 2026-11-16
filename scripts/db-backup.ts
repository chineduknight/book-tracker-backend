import { mkdir, open, rm, stat, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import mongoose from 'mongoose';
import { connectionOptionsFor } from '../src/db/mongo.js';
import { formatSafeError } from '../src/shared/safe-error.js';
import {
  manifestPathOf,
  summarizeCollections,
  type BackupManifest,
} from './backup/backup-manifest.js';
import {
  BackupRefusedError,
  DatabaseToolFailedError,
  runDatabaseTool,
  sha256Of,
} from './backup/database-tools.js';

/*
 * Operator backup; see docs/backup-and-restore.md.
 *   MONGODB_URI=<source> npm run db:backup -- --out-dir=<private directory outside the repo>
 * Read-only on the source. Writes <database>-<time>.archive.gz (mongodump, gzip) and a manifest
 * with its SHA-256 and per-collection counts. Never prints the URI or any document.
 */

const REPOSITORY_ROOT = resolve(import.meta.dirname, '..');
const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIRECTORY_MODE = 0o700;

function report(message: string): void {
  process.stdout.write(`[db:backup] ${message}\n`);
}

function outputDirectoryFrom(argv: readonly string[]): string {
  const [argument, ...rest] = argv;
  if (!argument?.startsWith('--out-dir=') || rest.length > 0) {
    throw new BackupRefusedError('usage: npm run db:backup -- --out-dir=<directory>');
  }
  return resolve(argument.slice('--out-dir='.length));
}

function isInside(parent: string, candidate: string): boolean {
  const path = relative(parent, candidate);
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
}

/** Backups contain every reader's data: keep them out of Git and away from other local users. */
async function preparePrivateDirectory(directory: string): Promise<void> {
  if (isInside(REPOSITORY_ROOT, directory)) {
    throw new BackupRefusedError(
      '--out-dir must be outside the repository so a backup is never committed',
    );
  }
  await mkdir(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  const { mode } = await stat(directory);
  if ((mode & 0o077) !== 0) {
    throw new BackupRefusedError('--out-dir must be accessible only by its owner (chmod 700)');
  }
}

function timestampForFileName(date: Date): string {
  return date.toISOString().replaceAll(':', '').replace('.', '-');
}

async function reserveFile(path: string): Promise<void> {
  const handle = await open(path, 'wx', PRIVATE_FILE_MODE);
  await handle.close();
}

async function main(): Promise<void> {
  const outputDirectory = outputDirectoryFrom(process.argv.slice(2));
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new BackupRefusedError('MONGODB_URI is required');
  await preparePrivateDirectory(outputDirectory);

  const connection = mongoose.createConnection(
    uri,
    connectionOptionsFor({ buildIndexesOnConnect: false }),
  );
  let archivePath: string | undefined;
  let completed = false;
  try {
    await connection.asPromise();
    const database = connection.name;
    if (database === 'test') {
      throw new BackupRefusedError('MONGODB_URI must name the application database explicitly');
    }
    const createdAt = new Date();
    archivePath = join(
      outputDirectory,
      `${database}-${timestampForFileName(createdAt)}.archive.gz`,
    );
    await reserveFile(archivePath);
    const collections = await summarizeCollections(connection);
    report(`dumping ${database} (${collections.length} collections)`);

    await runDatabaseTool('mongodump', uri, [
      `--db=${database}`,
      `--archive=${archivePath}`,
      '--gzip',
    ]);

    const manifest: BackupManifest = {
      format: 1,
      database,
      createdAt: createdAt.toISOString(),
      archive: basename(archivePath),
      bytes: (await stat(archivePath)).size,
      sha256: await sha256Of(archivePath),
      collections,
    };
    await writeFile(manifestPathOf(archivePath), `${JSON.stringify(manifest, null, 2)}\n`, {
      mode: PRIVATE_FILE_MODE,
      flag: 'wx',
    });
    completed = true;
    report(`wrote ${archivePath} (${manifest.bytes} bytes, sha256 ${manifest.sha256})`);
    for (const { name, documents } of collections) report(`  ${name}: ${documents} documents`);
  } finally {
    await connection.close();
    if (!completed && archivePath) {
      await rm(archivePath, { force: true });
      await rm(manifestPathOf(archivePath), { force: true });
    }
  }
}

main().catch((error: unknown) => {
  if (error instanceof BackupRefusedError) report(`refused: ${error.message}`);
  else if (error instanceof DatabaseToolFailedError) report(`failed: ${error.message}`);
  else report(`failed: ${formatSafeError(error)}`);
  process.exitCode = 1;
});
