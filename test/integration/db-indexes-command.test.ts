import type { Connection } from 'mongoose';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { inspectIndexes } from '../../src/db/index-verification.js';
import { CREDENTIAL_URI, expectNoCredentials } from '../helpers.js';
import { runScript } from '../support/run-script.js';
import {
  databaseOf,
  disposableDatabaseUri,
  dropDisposableDatabase,
  indexNamesOf,
  openDisposableDatabase,
  buildEveryRequiredIndex,
} from './disposable-databases.js';

const DRILL_DATABASE = 'book-tracker-test-index-command';
const COMMAND = 'scripts/db-indexes.ts';

let connection: Connection;

function runIndexCommand(args: string[] = [], uri = disposableDatabaseUri(DRILL_DATABASE)) {
  return runScript(COMMAND, args, { MONGODB_URI: uri });
}

beforeEach(async () => {
  connection = await openDisposableDatabase(DRILL_DATABASE);
});

afterEach(async () => {
  await dropDisposableDatabase(connection);
});

describe('npm run db:indexes', () => {
  it('checks read-only by default: lists missing indexes by name, exits 1 and builds nothing', async () => {
    await buildEveryRequiredIndex(connection);
    await databaseOf(connection).collection('loans').dropIndex('owner_copy_single_active');
    const before = await indexNamesOf(connection);

    const run = await runIndexCommand();

    expect(run.exitCode).toBe(1);
    expect(run.output).toContain(`[db:indexes] database ${DRILL_DATABASE}`);
    expect(run.output).toContain('missing     loans.owner_copy_single_active');
    expect(await indexNamesOf(connection)).toEqual(before);
    expectNoCredentials(run.output);
  });

  it('exits 0 when every required index is present', async () => {
    await buildEveryRequiredIndex(connection);

    const run = await runIndexCommand();

    expect(run.exitCode).toBe(0);
    expect(run.output).toContain('every required index is present');
  });

  it.each([
    [['--apply'], '--apply requires --confirm-database=<database name>'],
    [['--apply', '--confirm-database=book-tracker'], '--confirm-database does not match'],
    [['--drop'], 'unknown argument "--drop"'],
  ])('refuses %j without writing anything', async (args, refusal) => {
    const run = await runIndexCommand(args);

    expect(run.exitCode).toBe(1);
    expect(run.output).toContain(`refused: ${refusal}`);
    expect(await indexNamesOf(connection)).toEqual({});
  });

  it('builds the missing indexes when the database name is confirmed', async () => {
    const run = await runIndexCommand(['--apply', `--confirm-database=${DRILL_DATABASE}`]);

    expect(run.exitCode).toBe(0);
    expect(await inspectIndexes(connection)).toEqual({ discrepancies: [] });
  });

  it('refuses a URI without an explicit database name', async () => {
    const uri = new URL(disposableDatabaseUri(DRILL_DATABASE));
    uri.pathname = '/';

    const run = await runIndexCommand([], uri.toString());

    expect(run.exitCode).toBe(1);
    expect(run.output).toContain('refused: MONGODB_URI must name the application database');
  });

  it('reports an unreachable database by error name only, never the URI', async () => {
    const run = await runIndexCommand([], CREDENTIAL_URI);

    expect(run.exitCode).toBe(1);
    expect(run.output).toMatch(/\[db:indexes\] failed: \w+/);
    expectNoCredentials(run.output);
  });

  it('requires MONGODB_URI', async () => {
    const run = await runScript(COMMAND, [], {});

    expect(run.exitCode).toBe(1);
    expect(run.output).toContain('refused: MONGODB_URI is required');
  });
});
