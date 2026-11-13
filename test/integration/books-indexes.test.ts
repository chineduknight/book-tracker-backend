import mongoose from 'mongoose';
import { describe, expect, it } from 'vitest';
import { BookModel } from '../../src/modules/books/book.model.js';
import { indexesUsedBy } from './query-plans.js';

const ownerId = new mongoose.Types.ObjectId();
const activeBooks = { ownerId, deletedAt: null };

describe('book indexes', () => {
  it('declares only the planned indexes, none of them unique on title or ISBN', async () => {
    const indexes = await BookModel.collection.indexes();

    expect(indexes.map((index) => index.name).sort()).toEqual([
      '_id_',
      'owner_active_isbn',
      'owner_active_recent',
      'owner_active_text',
      'owner_active_title',
    ]);
    expect(indexes.filter((index) => index.unique)).toEqual([]);
  });

  it.each([
    [
      'default recent listing',
      () => BookModel.find(activeBooks).sort({ createdAt: -1, _id: -1 }),
      'owner_active_recent',
    ],
    [
      'oldest listing',
      () => BookModel.find(activeBooks).sort({ createdAt: 1, _id: 1 }),
      'owner_active_recent',
    ],
    [
      'title sort',
      () => BookModel.find(activeBooks).sort({ normalizedTitle: 1, _id: 1 }),
      'owner_active_title',
    ],
    [
      'reverse title sort',
      () => BookModel.find(activeBooks).sort({ normalizedTitle: -1, _id: -1 }),
      'owner_active_title',
    ],
    [
      'ISBN match',
      () => BookModel.find({ ...activeBooks, normalizedIsbn: '9780441013593' }),
      'owner_active_isbn',
    ],
    [
      'text search',
      () => BookModel.find({ ...activeBooks, $text: { $search: 'dune' } }),
      'owner_active_text',
    ],
  ])('uses an owner-scoped index for %s', async (_label, buildQuery, expectedIndex) => {
    expect(await indexesUsedBy(buildQuery())).toContain(expectedIndex);
  });

  it('cannot run a text search that is not scoped to an owner', async () => {
    await expect(
      BookModel.find({ deletedAt: null, $text: { $search: 'dune' } }).lean(),
    ).rejects.toThrow();
  });
});
