import { readFile } from 'node:fs/promises';
import type { Connection } from 'mongoose';
import { z } from 'zod';
import { BackupRefusedError } from './database-tools.js';

const collectionSummarySchema = z.object({
  name: z.string(),
  documents: z.number().int().nonnegative(),
  indexes: z.array(z.string()),
});

export const backupManifestSchema = z.object({
  format: z.literal(1),
  database: z.string(),
  createdAt: z.iso.datetime(),
  archive: z.string(),
  bytes: z.number().int().positive(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  collections: z.array(collectionSummarySchema),
});

export type BackupManifest = z.infer<typeof backupManifestSchema>;
export type CollectionSummary = z.infer<typeof collectionSummarySchema>;

export function manifestPathOf(archivePath: string): string {
  return `${archivePath}.manifest.json`;
}

/** Document counts and index names of every collection: numbers and names only, no contents. */
export async function summarizeCollections(connection: Connection): Promise<CollectionSummary[]> {
  const database = connection.db;
  if (!database) throw new BackupRefusedError('the database connection is not open');
  const collections = await database.listCollections({}, { nameOnly: true }).toArray();
  const summaries: CollectionSummary[] = [];
  for (const { name } of collections.sort((left, right) => left.name.localeCompare(right.name))) {
    if (name.startsWith('system.')) continue;
    const collection = database.collection(name);
    const indexes = await collection.indexes();
    summaries.push({
      name,
      documents: await collection.countDocuments({}),
      indexes: indexes.map((index) => String(index.name)).sort(),
    });
  }
  return summaries;
}

export async function readManifest(archivePath: string): Promise<BackupManifest> {
  let text: string;
  try {
    text = await readFile(manifestPathOf(archivePath), 'utf8');
  } catch {
    throw new BackupRefusedError('the archive has no readable manifest next to it');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new BackupRefusedError('the backup manifest is not valid JSON');
  }
  const manifest = backupManifestSchema.safeParse(parsed);
  if (!manifest.success) throw new BackupRefusedError('the backup manifest is not valid');
  return manifest.data;
}
