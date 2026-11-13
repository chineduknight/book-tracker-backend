import mongoose from 'mongoose';
import { describe, expect, it } from 'vitest';
import { PhysicalCopyModel } from '../../src/modules/copies/copy.model.js';
import { LocationModel } from '../../src/modules/locations/location.model.js';
import { indexesUsedBy } from './query-plans.js';

const ownerId = new mongoose.Types.ObjectId();
const bookId = new mongoose.Types.ObjectId();
const locationId = new mongoose.Types.ObjectId();

describe('location and copy indexes', () => {
  it('declares a unique per-owner location name and no unique copy constraints', async () => {
    const locationIndexes = await LocationModel.collection.indexes();
    const copyIndexes = await PhysicalCopyModel.collection.indexes();

    expect(locationIndexes.map((index) => [index.name, index.unique ?? false])).toEqual([
      ['_id_', false],
      ['owner_unique_name', true],
    ]);
    expect(copyIndexes.map((index) => index.name).sort()).toEqual([
      '_id_',
      'owner_book_active_recent',
      'owner_location_active',
    ]);
    expect(copyIndexes.filter((index) => index.unique)).toEqual([]);
  });

  it.each([
    [
      'alphabetical location listing',
      () => LocationModel.find({ ownerId }).sort({ normalizedName: 1, _id: 1 }),
      'owner_unique_name',
    ],
    [
      'copies of a book, newest first',
      () =>
        PhysicalCopyModel.find({ ownerId, bookId, deletedAt: null }).sort({
          createdAt: -1,
          _id: -1,
        }),
      'owner_book_active_recent',
    ],
    [
      'copies of a book filtered by location',
      () =>
        PhysicalCopyModel.find({ ownerId, bookId, deletedAt: null, locationId }).sort({
          createdAt: -1,
          _id: -1,
        }),
      'owner_book_active_recent',
    ],
    [
      'copies at a location',
      () => PhysicalCopyModel.find({ ownerId, locationId, deletedAt: null }),
      'owner_location_active',
    ],
  ])('uses an owner-scoped index for %s', async (_label, buildQuery, expectedIndex) => {
    expect(await indexesUsedBy(buildQuery())).toContain(expectedIndex);
  });
});
