import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import mongoose from 'mongoose';
import { describe, expect, it } from 'vitest';
import { requiredIndexesOf } from '../src/db/index-verification.js';

async function sourceFilesUnder(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => join(entry.parentPath, entry.name));
}

async function filesMentioning(files: readonly string[], pattern: RegExp): Promise<string[]> {
  const matches: string[] = [];
  for (const file of files) {
    if (pattern.test(await readFile(file, 'utf8'))) matches.push(file);
  }
  return matches;
}

/** Calls that drop indexes or rebuild them to match the schemas: test-database setup only. */
const DESTRUCTIVE_INDEX_CALLS = /\b(syncIndexes|cleanIndexes|dropIndex|dropIndexes|hideIndex)\b/;
const INDEX_BUILD_CALLS = /\b(createIndex|createIndexes|ensureIndexes)\b/;

describe('index safety outside the test suite', () => {
  it('no application or operator code can drop, hide or sync indexes', async () => {
    const files = [...(await sourceFilesUnder('src')), ...(await sourceFilesUnder('scripts'))];

    expect(await filesMentioning(files, DESTRUCTIVE_INDEX_CALLS)).toEqual([]);
  });

  it('only the opt-in operator command builds indexes; serving traffic never does', async () => {
    const files = [...(await sourceFilesUnder('src')), ...(await sourceFilesUnder('scripts'))];

    expect(await filesMentioning(files, INDEX_BUILD_CALLS)).toEqual([
      join('scripts', 'indexes', 'build-missing-indexes.ts'),
    ]);
  });
});

describe('index inventory documentation', () => {
  it('lists exactly the indexes the schemas define', async () => {
    const documentation = await readFile('docs/index-operations.md', 'utf8');
    const documentedRows = [...documentation.matchAll(/^\| `(\w+)`\s+\| \*{0,2}`(\w+)`/gm)].map(
      ([, collection, index]) => `${collection}.${index}`,
    );

    expect(documentedRows).toEqual(
      requiredIndexesOf(mongoose.connection).map(({ collection, name }) => `${collection}.${name}`),
    );
  });
});
