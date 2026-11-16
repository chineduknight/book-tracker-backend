import mongoose, { type Connection } from 'mongoose';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applicationModelsOn } from '../../src/db/application-models.js';
import {
  blockingDiscrepanciesOf,
  inspectIndexes,
  requiredIndexesOf,
} from '../../src/db/index-verification.js';
import {
  buildMissingIndexes,
  ConflictingIndexesError,
} from '../../scripts/indexes/build-missing-indexes.js';
import {
  databaseOf,
  dropDisposableDatabase,
  indexNamesOf,
  openDisposableDatabase,
  buildEveryRequiredIndex,
} from './disposable-databases.js';

let connection: Connection;

beforeEach(async () => {
  connection = await openDisposableDatabase('book-tracker-test-index-drill');
});

afterEach(async () => {
  await dropDisposableDatabase(connection);
});

describe('read-only index inspection', () => {
  it('reports every required index as missing on an empty database, and creates nothing', async () => {
    const report = await inspectIndexes(connection);
    await Promise.all(applicationModelsOn(connection).map((model) => model.init()));

    expect(blockingDiscrepanciesOf(report)).toHaveLength(requiredIndexesOf(connection).length);
    expect(report.discrepancies.every(({ problem }) => problem === 'missing')).toBe(true);
    expect(await indexNamesOf(connection)).toEqual({});
  });

  it('reports nothing once every required index exists', async () => {
    await buildEveryRequiredIndex(connection);

    expect(await inspectIndexes(connection)).toEqual({ discrepancies: [] });
  });

  it('names a dropped unique index as missing without touching the remaining indexes', async () => {
    await buildEveryRequiredIndex(connection);
    await databaseOf(connection).collection('loans').dropIndex('owner_copy_single_active');
    const before = await indexNamesOf(connection);

    const report = await inspectIndexes(connection);

    expect(report.discrepancies).toEqual([
      { collection: 'loans', index: 'owner_copy_single_active', problem: 'missing' },
    ]);
    expect(await indexNamesOf(connection)).toEqual(before);
  });

  it.each([
    [
      'not unique',
      'loans',
      'owner_copy_single_active',
      { ownerId: 1, copyId: 1 },
      { partialFilterExpression: { returnedOn: null } },
    ],
    [
      'unique without its partial filter',
      'loans',
      'owner_copy_single_active',
      { ownerId: 1, copyId: 1 },
      { unique: true },
    ],
    [
      'partial on the wrong status',
      'refreshtokens',
      'sessionId_1',
      { sessionId: 1 },
      { unique: true, partialFilterExpression: { status: 'revoked' } },
    ],
    [
      'given a different TTL',
      'sessions',
      'expiresAt_1',
      { expiresAt: 1 },
      { expireAfterSeconds: 3600 },
    ],
  ])(
    'reports an index that is %s as conflicting, so it does not pass for the invariant',
    async (_label, collection, index, keys, options) => {
      await buildEveryRequiredIndex(connection);
      await databaseOf(connection).collection(collection).dropIndex(index);
      await databaseOf(connection)
        .collection(collection)
        .createIndex(keys, { ...options, name: index });

      const report = await inspectIndexes(connection);

      expect(blockingDiscrepanciesOf(report)).toEqual([
        { collection, index, problem: 'conflicting' },
      ]);
    },
  );

  it('reports an index the schemas do not define as unexpected, without blocking or dropping it', async () => {
    await buildEveryRequiredIndex(connection);
    await databaseOf(connection)
      .collection('books')
      .createIndex({ isbn: 1 }, { name: 'operator_isbn' });

    const report = await inspectIndexes(connection);

    expect(report.discrepancies).toEqual([
      { collection: 'books', index: 'operator_isbn', problem: 'unexpected' },
    ]);
    expect(blockingDiscrepanciesOf(report)).toEqual([]);
    expect((await indexNamesOf(connection)).books).toContain('operator_isbn');
  });
});

describe('connection options', () => {
  it('builds nothing on connect with production options, and everything with development options', async () => {
    await Promise.all(applicationModelsOn(connection).map((model) => model.init()));
    expect(await indexNamesOf(connection)).toEqual({});

    const development = await openDisposableDatabase('book-tracker-test-index-drill-dev', {
      buildIndexesOnConnect: true,
    });
    try {
      await Promise.all(applicationModelsOn(development).map((model) => model.init()));
      expect(await inspectIndexes(development)).toEqual({ discrepancies: [] });
    } finally {
      await dropDisposableDatabase(development);
    }
  });
});

describe('additive index builds', () => {
  it('builds every missing index on an empty database, creating the collections', async () => {
    const { failures, report } = await buildMissingIndexes(connection);

    expect(failures).toEqual([]);
    expect(report).toEqual({ discrepancies: [] });
  });

  it('builds only what is missing and keeps unexpected indexes', async () => {
    await buildEveryRequiredIndex(connection);
    await databaseOf(connection).collection('loans').dropIndex('owner_copy_single_active');
    await databaseOf(connection)
      .collection('books')
      .createIndex({ isbn: 1 }, { name: 'operator_isbn' });

    const { failures, report } = await buildMissingIndexes(connection);

    expect(failures).toEqual([]);
    expect(report.discrepancies).toEqual([
      { collection: 'books', index: 'operator_isbn', problem: 'unexpected' },
    ]);
  });

  it('refuses to build anything while a required index conflicts', async () => {
    await buildEveryRequiredIndex(connection);
    const loans = databaseOf(connection).collection('loans');
    await loans.dropIndex('owner_copy_single_active');
    await loans.createIndex({ ownerId: 1, copyId: 1 }, { name: 'owner_copy_single_active' });
    await databaseOf(connection).collection('users').dropIndex('email_1');

    await expect(buildMissingIndexes(connection)).rejects.toBeInstanceOf(ConflictingIndexesError);
    expect((await indexNamesOf(connection)).users).not.toContain('email_1');
  });

  it('stops on duplicate documents instead of deleting any, and leaves the API not ready', async () => {
    await buildEveryRequiredIndex(connection);
    const loans = databaseOf(connection).collection('loans');
    await loans.dropIndex('owner_copy_single_active');
    const ownerId = new mongoose.Types.ObjectId();
    const copyId = new mongoose.Types.ObjectId();
    await loans.insertMany([
      { ownerId, copyId, returnedOn: null, borrowerName: 'Synthetic A' },
      { ownerId, copyId, returnedOn: null, borrowerName: 'Synthetic B' },
    ]);

    const { failures, report } = await buildMissingIndexes(connection);

    expect(failures).toEqual([
      {
        collection: 'loans',
        reason: 'existing_documents_violate_a_unique_index',
        error: { name: 'MongoServerError', code: 11000 },
      },
    ]);
    expect(blockingDiscrepanciesOf(report)).toEqual([
      { collection: 'loans', index: 'owner_copy_single_active', problem: 'missing' },
    ]);
    expect(await loans.countDocuments()).toBe(2);
  });
});
