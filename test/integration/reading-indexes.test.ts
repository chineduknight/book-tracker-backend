import mongoose from 'mongoose';
import { describe, expect, it } from 'vitest';
import { ReadingSessionModel } from '../../src/modules/reading/reading.model.js';
import { indexNamesIn, indexesUsedBy } from './query-plans.js';

const ownerId = new mongoose.Types.ObjectId();
const bookId = new mongoose.Types.ObjectId();

describe('reading session indexes', () => {
  it('declares the history indexes and a partial unique in-progress index', async () => {
    const indexes = await ReadingSessionModel.collection.indexes();

    expect(indexes.map((index) => index.name).sort()).toEqual([
      '_id_',
      'owner_book_recent',
      'owner_book_single_in_progress',
      'owner_recent',
      'owner_status_recent',
    ]);
    expect(indexes.find((index) => index.name === 'owner_book_single_in_progress')).toMatchObject({
      key: { ownerId: 1, bookId: 1 },
      unique: true,
      partialFilterExpression: { status: 'in_progress' },
    });
    expect(indexes.filter((index) => index.unique).map((index) => index.name)).toEqual([
      'owner_book_single_in_progress',
    ]);
  });

  it.each([
    [
      'one book’s history',
      () => ReadingSessionModel.find({ ownerId, bookId }).sort({ createdAt: -1, _id: -1 }),
      'owner_book_recent',
    ],
    [
      'global history filtered by status',
      () =>
        ReadingSessionModel.find({ ownerId, status: 'completed' }).sort({ createdAt: -1, _id: -1 }),
      'owner_status_recent',
    ],
    [
      'global history',
      () => ReadingSessionModel.find({ ownerId }).sort({ createdAt: 1, _id: 1 }),
      'owner_recent',
    ],
  ])('uses an owner-scoped index for %s', async (_label, buildQuery, expectedIndex) => {
    expect(await indexesUsedBy(buildQuery())).toContain(expectedIndex);
  });

  it('starts the global history aggregation from an owner-scoped index', async () => {
    const explanation = await ReadingSessionModel.aggregate([
      { $match: { ownerId, status: 'completed' } },
      { $sort: { createdAt: -1, _id: -1 } },
    ]).explain('queryPlanner');

    expect(indexNamesIn(explanation)).toContain('owner_status_recent');
  });
});
