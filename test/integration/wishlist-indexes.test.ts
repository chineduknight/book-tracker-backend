import mongoose from 'mongoose';
import { beforeEach, describe, expect, it } from 'vitest';
import { WishlistItemModel } from '../../src/modules/wishlist/wishlist.model.js';
import { indexesUsedBy, stagesUsedBy } from './query-plans.js';

const ownerId = new mongoose.Types.ObjectId();
const activeItems = { ownerId, deletedAt: null };
const RECENT = { createdAt: -1, _id: -1 } as const;

async function seedWishesOfSeveralReaders() {
  const owners = [ownerId, new mongoose.Types.ObjectId(), new mongoose.Types.ObjectId()];
  const priorities = ['high', 'medium', 'low'] as const;
  await WishlistItemModel.insertMany(
    owners.flatMap((owner) =>
      Array.from({ length: 40 }, (_, index) => ({
        ownerId: owner,
        title: `Dragon wish ${index}`,
        normalizedTitle: `dragon wish ${index}`,
        authors: index % 2 === 0 ? ['Ann Author'] : [],
        priority: priorities[index % 3],
        priorityRank: index % 3,
        note: index % 4 === 0 ? 'birthday' : undefined,
        status: index % 5 === 0 ? 'acquired' : 'wanted',
        acquiredBookId: index % 5 === 0 ? new mongoose.Types.ObjectId() : null,
        deletedAt: index % 7 === 0 ? new Date() : null,
      })),
    ),
  );
}

describe('wishlist indexes', () => {
  beforeEach(seedWishesOfSeveralReaders);

  it('declares the planned owner-scoped indexes and nothing unique', async () => {
    const indexes = await WishlistItemModel.collection.indexes();

    expect(indexes.map((index) => index.name).sort()).toEqual([
      '_id_',
      'owner_active_priority',
      'owner_active_status_recent',
      'owner_active_text',
      'owner_active_title',
    ]);
    expect(indexes.filter((index) => index.unique)).toEqual([]);
    expect(indexes.find((index) => index.name === 'owner_active_text')).toMatchObject({
      key: { ownerId: 1, deletedAt: 1, _fts: 'text', _ftsx: 1 },
      weights: { title: 1, authors: 1, note: 1 },
      default_language: 'none',
    });
  });

  it.each([
    [
      'the default wanted list',
      () => WishlistItemModel.find({ ...activeItems, status: 'wanted' }).sort(RECENT),
      'owner_active_status_recent',
    ],
    [
      'the acquired list, oldest first',
      () =>
        WishlistItemModel.find({ ...activeItems, status: 'acquired' }).sort({
          createdAt: 1,
          _id: 1,
        }),
      'owner_active_status_recent',
    ],
    [
      'title order',
      () => WishlistItemModel.find(activeItems).sort({ normalizedTitle: 1, _id: 1 }),
      'owner_active_title',
    ],
    [
      'priority order over all statuses',
      () => WishlistItemModel.find(activeItems).sort({ priorityRank: 1, createdAt: -1, _id: -1 }),
      'owner_active_priority',
    ],
  ])('serves %s from an owner-scoped index without sorting in memory', async (_l, query, index) => {
    expect(await indexesUsedBy(query())).toEqual([index]);
    expect(await stagesUsedBy(query())).not.toContain('SORT');
  });

  it('serves a mixed status and priority filter from some owner-scoped index, never a scan', async () => {
    const query = () =>
      WishlistItemModel.find({ ...activeItems, status: 'wanted', priority: 'high' }).sort(RECENT);

    const indexes = await indexesUsedBy(query());
    expect(indexes).toHaveLength(1);
    expect(indexes[0]).toMatch(/^owner_active_/);
    expect(await stagesUsedBy(query())).not.toContain('COLLSCAN');
  });

  it('serves text search from the compound text index scoped to active items of the owner', async () => {
    const search = () =>
      WishlistItemModel.find({
        ...activeItems,
        status: 'wanted',
        $text: { $search: 'dragon' },
      }).sort(RECENT);

    expect(await indexesUsedBy(search())).toEqual(['owner_active_text']);
    expect(await stagesUsedBy(search())).toContain('TEXT_MATCH');
    expect(await search().countDocuments()).toBe(28);
  });

  it.each([
    ['no owner or deletion filter', {}],
    ['an owner filter alone', { ownerId }],
    ['a deletion filter alone', { deletedAt: null }],
  ])('refuses a text search with %s', async (_label, scope) => {
    await expect(
      WishlistItemModel.find({ ...scope, $text: { $search: 'dragon' } }),
    ).rejects.toThrow(/text index/i);
  });
});
