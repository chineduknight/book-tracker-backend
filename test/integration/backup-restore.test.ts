import { spawnSync } from 'node:child_process';
import { appendFile, chmod, mkdir, mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import mongoose, { type Connection } from 'mongoose';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { connectionOptionsFor } from '../../src/db/mongo.js';
import { backupManifestSchema } from '../../scripts/backup/backup-manifest.js';
import { createTestApp, CREDENTIAL_URI, expectNoCredentials } from '../helpers.js';
import { runScript } from '../support/run-script.js';
import { registerReader } from './auth-fixtures.js';
import { seedLibrary, TINY_LIBRARY } from './scale-fixtures.js';
import { TEST_DATABASE_NAME, testDatabaseUri } from './test-database.js';

const REHEARSAL_DATABASE = 'book-tracker-restore-rehearsal';
const databaseToolsAvailable = spawnSync('mongodump', ['--version']).status === 0;
/** CI sets this so a missing toolchain fails the run instead of silently skipping the drill. */
const databaseToolsRequired = process.env.REQUIRE_DATABASE_TOOLS === '1';

let workspace: string;
let rehearsal: Connection;

function rehearsalUri(): string {
  const uri = new URL(testDatabaseUri());
  uri.pathname = `/${REHEARSAL_DATABASE}`;
  return uri.toString();
}

async function backUp(outDir: string, uri = testDatabaseUri()) {
  return runScript('scripts/db-backup.ts', [`--out-dir=${outDir}`], {
    MONGODB_URI: uri,
    TMPDIR: join(workspace, 'tool-temp'),
  });
}

async function rehearse(archive: string, uri = rehearsalUri()) {
  return runScript('scripts/db-restore-rehearsal.ts', [`--archive=${archive}`], {
    RESTORE_REHEARSAL_URI: uri,
    TMPDIR: join(workspace, 'tool-temp'),
  });
}

/** Private config files the scripts write for mongodump/mongorestore; tsx keeps its own cache. */
async function toolConfigDirectoriesLeft(): Promise<string[]> {
  const entries = await readdir(join(workspace, 'tool-temp'));
  return entries.filter((entry) => entry.startsWith('book-tracker-db-tool-'));
}

async function archiveIn(directory: string): Promise<string> {
  const files = await readdir(directory);
  const archive = files.find((file) => file.endsWith('.archive.gz'));
  if (!archive) throw new Error('no archive was written');
  return join(directory, archive);
}

async function seedSyntheticLibrary(): Promise<void> {
  const { user } = await registerReader(createTestApp());
  await seedLibrary(user.id, TINY_LIBRARY);
}

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'book-tracker-backup-drill-'));
  await mkdir(join(workspace, 'tool-temp'), { mode: 0o700 });
  rehearsal = mongoose.createConnection(rehearsalUri(), {
    ...connectionOptionsFor({ buildIndexesOnConnect: false }),
    dbName: REHEARSAL_DATABASE,
  });
  await rehearsal.asPromise();
  await rehearsal.dropDatabase();
});

afterEach(async () => {
  await rehearsal.dropDatabase();
  await rehearsal.close();
  await rm(workspace, { recursive: true, force: true });
});

describe.skipIf(!databaseToolsAvailable && !databaseToolsRequired)(
  'backup and restore rehearsal',
  () => {
    it('has the MongoDB Database Tools installed', () => {
      expect(databaseToolsAvailable).toBe(true);
    });

    it('backs up synthetic data into private files and restores it into an isolated database that passes every check', async () => {
      await seedSyntheticLibrary();
      const backups = join(workspace, 'backups');

      const backup = await backUp(backups);
      const archive = await archiveIn(backups);
      const manifest = backupManifestSchema.parse(
        JSON.parse(await readFile(`${archive}.manifest.json`, 'utf8')),
      );
      const restore = await rehearse(archive);

      expect(backup.exitCode).toBe(0);
      expect((await stat(backups)).mode & 0o777).toBe(0o700);
      expect((await stat(archive)).mode & 0o777).toBe(0o600);
      expect((await stat(`${archive}.manifest.json`)).mode & 0o777).toBe(0o600);
      expect(manifest.database).toBe(TEST_DATABASE_NAME);
      expect(manifest.collections.find(({ name }) => name === 'books')?.documents).toBe(
        TINY_LIBRARY.books,
      );
      expect(restore.exitCode).toBe(0);
      expect(restore.output).toContain('verified');
      expect(await toolConfigDirectoriesLeft()).toEqual([]);
      for (const output of [backup.output, restore.output]) expectNoCredentials(output);
    });

    it('restores working unique indexes: a second active loan for a copy is still refused', async () => {
      await seedSyntheticLibrary();
      const backups = join(workspace, 'backups');
      await backUp(backups);
      const restore = await rehearse(await archiveIn(backups));
      expect(restore.exitCode, restore.output).toBe(0);

      const loans = rehearsal.collection('loans');
      const activeLoan = await loans.findOne({ returnedOn: null });
      expect(activeLoan).not.toBeNull();
      await expect(
        loans.insertOne({
          ownerId: activeLoan?.ownerId,
          copyId: activeLoan?.copyId,
          returnedOn: null,
        }),
      ).rejects.toMatchObject({ code: 11000 });
    });

    it('refuses to restore over a database that is not empty, and leaves it untouched', async () => {
      await seedSyntheticLibrary();
      const backups = join(workspace, 'backups');
      await backUp(backups);
      await rehearsal.collection('books').insertOne({ title: 'Already here' });

      const restore = await rehearse(await archiveIn(backups));

      expect(restore.exitCode).toBe(1);
      expect(restore.output).toContain(`refused: ${REHEARSAL_DATABASE} is not empty`);
      expect(await rehearsal.collection('books').countDocuments()).toBe(1);
    });

    it.each([
      [
        'a remote server',
        'mongodb+srv://admin:hunter2@cluster0.db.example.test/book-tracker-restore-rehearsal',
      ],
      ['another database name', 'mongodb://127.0.0.1:27017/book-tracker'],
      ['the production-looking database', 'mongodb://127.0.0.1:27017/book-tracker-production'],
    ])('refuses %s as the restore target before connecting', async (_label, target) => {
      await seedSyntheticLibrary();
      const backups = join(workspace, 'backups');
      await backUp(backups);

      const restore = await rehearse(await archiveIn(backups), target);

      expect(restore.exitCode).toBe(1);
      expect(restore.output).toContain('refused: RESTORE_REHEARSAL_URI');
      // The refusal states the rule ("must be a mongodb:// URI ..."), so check the secret parts.
      for (const secretPart of ['hunter2', 'admin:', 'cluster0']) {
        expect(restore.output).not.toContain(secretPart);
      }
    });

    it('refuses an archive that no longer matches its checksum', async () => {
      const backups = join(workspace, 'backups');
      await backUp(backups);
      const archive = await archiveIn(backups);
      await appendFile(archive, 'tampered');

      const restore = await rehearse(archive);

      expect(restore.exitCode).toBe(1);
      expect(restore.output).toContain('refused: the archive does not match its manifest checksum');
      expect(await rehearsal.db?.listCollections().toArray()).toEqual([]);
    });

    it('refuses to write a backup inside the repository', async () => {
      const insideRepository = join(process.cwd(), 'backups-refusal-check');
      try {
        const backup = await backUp(insideRepository);

        expect(backup.exitCode).toBe(1);
        expect(backup.output).toContain('refused: --out-dir must be outside the repository');
      } finally {
        // If the guard ever regresses, never leave a dump in the working tree.
        await rm(insideRepository, { recursive: true, force: true });
      }
    });

    it('refuses an output directory other local users can read', async () => {
      const shared = join(workspace, 'shared');
      await mkdir(shared);
      await chmod(shared, 0o755);

      const backup = await backUp(shared);

      expect(backup.exitCode).toBe(1);
      expect(backup.output).toContain('refused: --out-dir must be accessible only by its owner');
      expect(await readdir(shared)).toEqual([]);
    });

    it('leaves no partial archive or credentials behind when the source is unreachable', async () => {
      const backups = join(workspace, 'backups');

      const backup = await backUp(backups, CREDENTIAL_URI);

      expect(backup.exitCode).toBe(1);
      expect(await readdir(backups)).toEqual([]);
      expect(await toolConfigDirectoriesLeft()).toEqual([]);
      expectNoCredentials(backup.output);
    });
  },
);
