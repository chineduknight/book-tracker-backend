import mongoose from 'mongoose';
import { beforeAll, describe, expect, it } from 'vitest';
import { BookModel } from '../../src/modules/books/book.model.js';
import { keepDocumentsOfActiveBooks } from '../../src/modules/books/book.service.js';
import { PhysicalCopyModel } from '../../src/modules/copies/copy.model.js';
import { LoanModel } from '../../src/modules/loans/loan.model.js';
import { NoteModel } from '../../src/modules/notes/note.model.js';
import { ReadingSessionModel } from '../../src/modules/reading/reading.model.js';
import { WishlistItemModel } from '../../src/modules/wishlist/wishlist.model.js';
import { winningIndexesOf, winningStagesOf } from './query-plans.js';

const ownerId = new mongoose.Types.ObjectId();
const owners = [ownerId, new mongoose.Types.ObjectId(), new mongoose.Types.ObjectId()];
const RECENT = { createdAt: -1, _id: -1 } as const;

async function seedLibrariesOfSeveralReaders() {
  for (const owner of owners) {
    const books = await BookModel.insertMany(
      Array.from({ length: 30 }, (_, index) => ({
        ownerId: owner,
        title: `Book ${index}`,
        normalizedTitle: `book ${index}`,
        format: index % 3 === 0 ? 'ebook' : 'physical',
        deletedAt: index % 7 === 0 ? new Date() : null,
      })),
    );
    await ReadingSessionModel.insertMany(
      books.map((book, index) => ({
        ownerId: owner,
        bookId: book._id,
        status: index % 2 === 0 ? 'completed' : 'in_progress',
      })),
    );
    await NoteModel.insertMany(
      books.map((book, index) => ({
        ownerId: owner,
        bookId: book._id,
        kind: index % 2 === 0 ? 'note' : 'highlight',
        content: 'x',
      })),
    );
    await PhysicalCopyModel.insertMany(books.map((book) => ({ ownerId: owner, bookId: book._id })));
    await WishlistItemModel.insertMany(
      Array.from({ length: 30 }, (_, index) => ({
        ownerId: owner,
        title: `Wish ${index}`,
        normalizedTitle: `wish ${index}`,
        priorityRank: 1,
        status: index % 4 === 0 ? 'acquired' : 'wanted',
      })),
    );
    await LoanModel.insertMany(
      books.map((book, index) => ({
        ownerId: owner,
        copyId: new mongoose.Types.ObjectId(),
        bookId: book._id,
        borrowerName: 'B',
        lentOn: '2026-01-01',
        dueOn: '2026-02-01',
        returnedOn: index % 3 === 0 ? '2026-03-01' : null,
      })),
    );
  }
}

function expectOwnerScopedPlan(explanation: unknown) {
  const indexes = winningIndexesOf(explanation);
  expect(indexes.length).toBeGreaterThan(0);
  for (const index of indexes) expect(index).toMatch(/^owner_/);
  expect(winningStagesOf(explanation)).not.toContain('COLLSCAN');
}

describe('dashboard query plans', () => {
  beforeAll(seedLibrariesOfSeveralReaders);

  it.each([
    [
      'active book identities',
      () => BookModel.find({ ownerId, deletedAt: null }).select({ format: 1 }),
    ],
    [
      'active wishes by status',
      () => WishlistItemModel.find({ ownerId, deletedAt: null, status: 'wanted' }),
    ],
    ['active loans', () => LoanModel.find({ ownerId, returnedOn: null })],
    [
      'overdue loans',
      () => LoanModel.find({ ownerId, returnedOn: null, dueOn: { $lt: '2026-11-14' } }),
    ],
    ['returned loans', () => LoanModel.find({ ownerId, returnedOn: { $ne: null } })],
    [
      'recent wishes',
      () => WishlistItemModel.find({ ownerId, deletedAt: null }).sort(RECENT).limit(20),
    ],
  ])('serves %s from an owner-scoped index', async (_label, query) => {
    expectOwnerScopedPlan(await query().explain('queryPlanner'));
  });

  it.each([
    ['recent books', () => BookModel.find({ ownerId, deletedAt: null }).sort(RECENT).limit(20)],
    ['recent loans', () => LoanModel.find({ ownerId }).sort(RECENT).limit(20)],
  ])('serves %s in index order without sorting in memory', async (_label, query) => {
    const explanation = await query().explain('queryPlanner');
    expectOwnerScopedPlan(explanation);
    expect(winningStagesOf(explanation)).not.toContain('SORT');
  });

  it.each([
    [
      'reading tallies per book',
      () =>
        ReadingSessionModel.aggregate([
          { $match: { ownerId } },
          { $group: { _id: '$bookId', sessions: { $sum: 1 } } },
          ...keepDocumentsOfActiveBooks(ownerId.toHexString(), '_id'),
        ]),
    ],
    [
      'visible copies per book',
      () =>
        PhysicalCopyModel.aggregate([
          { $match: { ownerId, deletedAt: null } },
          { $group: { _id: '$bookId', copies: { $sum: 1 } } },
          ...keepDocumentsOfActiveBooks(ownerId.toHexString(), '_id'),
        ]),
    ],
    [
      'notes by book and kind',
      () =>
        NoteModel.aggregate([
          { $match: { ownerId, deletedAt: null } },
          { $group: { _id: { bookId: '$bookId', kind: '$kind' }, count: { $sum: 1 } } },
          ...keepDocumentsOfActiveBooks(ownerId.toHexString(), '_id.bookId'),
        ]),
    ],
    [
      'recent sessions of active books',
      () =>
        ReadingSessionModel.aggregate([
          { $match: { ownerId } },
          { $sort: RECENT },
          ...keepDocumentsOfActiveBooks(ownerId.toHexString(), 'bookId'),
          { $limit: 20 },
        ]),
    ],
    [
      'recent notes of active books',
      () =>
        NoteModel.aggregate([
          { $match: { ownerId, deletedAt: null } },
          { $sort: RECENT },
          ...keepDocumentsOfActiveBooks(ownerId.toHexString(), 'bookId'),
          { $limit: 20 },
        ]),
    ],
  ])('starts the %s aggregation from an owner-scoped index', async (_label, pipeline) => {
    expectOwnerScopedPlan(await pipeline().explain('queryPlanner'));
  });
});
