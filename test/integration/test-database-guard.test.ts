import { spawn } from 'node:child_process';
import { once } from 'node:events';
import mongoose from 'mongoose';
import { describe, expect, it } from 'vitest';
import { UserModel } from '../../src/modules/users/user.model.js';
import { TEST_DATABASE_NAME, testDatabaseUri } from './test-database.js';

const SENTINEL_EMAIL = 'sentinel@guard.example.test';

/** Runs one integration test file in a child process with another MONGODB_TEST_URI. */
async function runIntegrationSuiteWith(databaseUri: string) {
  const child = spawn(
    process.execPath,
    [
      'node_modules/vitest/vitest.mjs',
      'run',
      '--config',
      'vitest.integration.config.ts',
      'test/integration/current-user.test.ts',
    ],
    {
      env: { ...process.env, MONGODB_TEST_URI: databaseUri },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let output = '';
  child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
  child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
  const [exitCode] = (await once(child, 'exit')) as [number | null];
  return { exitCode, output };
}

describe('integration suite database guard', () => {
  /*
   * The URI reaches the same local server as this suite but names another database. Without the
   * guard, the `dbName` override would still point the child at this test database and its
   * before-each cleanup would delete the sentinel.
   */
  it('refuses another database name before connecting, deleting or building indexes', async () => {
    await UserModel.collection.insertOne({
      name: 'Sentinel',
      email: SENTINEL_EMAIL,
      passwordHash: 'not-a-real-hash',
    });
    const otherDatabaseUri = testDatabaseUri().replace(
      `/${TEST_DATABASE_NAME}?`,
      '/book-tracker-production?',
    );
    const indexesBefore = await UserModel.collection.indexes();

    const { exitCode, output } = await runIntegrationSuiteWith(otherDatabaseUri);

    expect(exitCode).not.toBe(0);
    expect(output).toContain('MONGODB_TEST_URI must name the book-tracker-test database');
    expect(output).not.toContain('book-tracker-production');
    expect(await UserModel.collection.countDocuments({ email: SENTINEL_EMAIL })).toBe(1);
    expect(await UserModel.collection.indexes()).toEqual(indexesBefore);
    const databases = await mongoose.connection.db?.admin().listDatabases({ nameOnly: true });
    expect(databases?.databases.map(({ name }) => name)).not.toContain('book-tracker-production');
  }, 60_000);

  it('never prints the credentials or host of a refused remote URI', async () => {
    const { exitCode, output } = await runIntegrationSuiteWith(
      'mongodb+srv://admin:hunter2@cluster0.db.example.test/book-tracker-test',
    );

    expect(exitCode).not.toBe(0);
    expect(output).toContain('MONGODB_TEST_URI must be a mongodb:// URI with one local host');
    for (const secretPart of ['hunter2', 'admin:', 'cluster0', 'example.test']) {
      expect(output).not.toContain(secretPart);
    }
  }, 60_000);
});
