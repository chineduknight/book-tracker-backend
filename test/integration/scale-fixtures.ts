import mongoose from 'mongoose';
import { BookModel } from '../../src/modules/books/book.model.js';
import { CategoryModel } from '../../src/modules/categories/category.model.js';
import { BookCollectionModel } from '../../src/modules/collections/collection.model.js';
import { PhysicalCopyModel } from '../../src/modules/copies/copy.model.js';
import { LoanModel } from '../../src/modules/loans/loan.model.js';
import { LocationModel } from '../../src/modules/locations/location.model.js';
import { NoteModel } from '../../src/modules/notes/note.model.js';
import { ReadingSessionModel } from '../../src/modules/reading/reading.model.js';
import { WishlistItemModel } from '../../src/modules/wishlist/wishlist.model.js';

/** Record counts of one seeded library; every count is a number of stored documents. */
export interface LibrarySize {
  books: number;
  deletedBooks: number;
  copies: number;
  readingSessions: number;
  notes: number;
  groupMembers: number;
  wishes: number;
  loans: number;
}

export const PERSONAL_LIBRARY: LibrarySize = {
  books: 300,
  deletedBooks: 20,
  copies: 300,
  readingSessions: 1_000,
  notes: 2_000,
  groupMembers: 300,
  wishes: 200,
  loans: 500,
};

export const TINY_LIBRARY: LibrarySize = {
  books: 3,
  deletedBooks: 1,
  copies: 2,
  readingSessions: 3,
  notes: 3,
  groupMembers: 2,
  wishes: 2,
  loans: 2,
};

const SEEDED_AT = Date.parse('2026-01-01T00:00:00.000Z');

/** Distinct, increasing creation times, so that ordering never depends on insertion speed. */
function timestampsFor(position: number) {
  const moment = new Date(SEEDED_AT + position * 1_000);
  return { createdAt: moment, updatedAt: moment };
}

function idsOf(count: number) {
  return Array.from({ length: count }, () => new mongoose.Types.ObjectId());
}

/*
 * Writes a whole library straight through the driver: the API would take minutes to build it.
 * Documents have every field their schema requires, so the API reads them like its own.
 */
export async function seedLibrary(ownerIdText: string, size: LibrarySize) {
  const ownerId = new mongoose.Types.ObjectId(ownerIdText);
  const bookIds = idsOf(size.books);
  const copyIds = idsOf(size.copies);
  const bookOf = (position: number) => bookIds[position % bookIds.length];
  const isDeletedBook = (position: number) => position >= size.books - size.deletedBooks;
  const locationId = new mongoose.Types.ObjectId();

  await LocationModel.collection.insertOne({
    _id: locationId,
    ownerId,
    name: `Shelf ${ownerIdText}`,
    normalizedName: `shelf ${ownerIdText}`,
    ...timestampsFor(0),
  });
  await BookModel.collection.insertMany(
    bookIds.map((_id, position) => ({
      _id,
      ownerId,
      title: `Seeded book ${position}`,
      normalizedTitle: `seeded book ${position}`,
      authors: [`Author ${position % 40}`],
      format: position % 5 === 0 ? 'ebook' : 'physical',
      hasPhysicalCopyHistory: position % 5 !== 0,
      deletedAt: isDeletedBook(position) ? new Date(SEEDED_AT) : null,
      ...timestampsFor(position),
    })),
  );
  await PhysicalCopyModel.collection.insertMany(
    copyIds.map((_id, position) => ({
      _id,
      ownerId,
      bookId: bookOf(position),
      locationId: position % 2 === 0 ? locationId : null,
      deletedAt: null,
      ...timestampsFor(position),
    })),
  );
  await ReadingSessionModel.collection.insertMany(
    Array.from({ length: size.readingSessions }, (_unused, position) => ({
      ownerId,
      bookId: bookOf(position),
      ...(position < size.books && position % 10 === 0
        ? { status: 'in_progress' }
        : { status: 'completed', completedOn: '2026-01-02' }),
      progress: null,
      revision: 0,
      ...timestampsFor(position),
    })),
  );
  await NoteModel.collection.insertMany(
    Array.from({ length: size.notes }, (_unused, position) => ({
      ownerId,
      bookId: bookOf(position),
      readingSessionId: null,
      kind: position % 3 === 0 ? 'highlight' : 'note',
      content: `Seeded note ${position} about chapter ${position % 12}`,
      chapter: `Chapter ${position % 12}`,
      chapterKey: `chapter ${position % 12}`,
      deletedAt: null,
      ...timestampsFor(position),
    })),
  );
  const members = bookIds.slice(0, size.groupMembers);
  for (const model of [CategoryModel, BookCollectionModel]) {
    await model.collection.insertOne({
      ownerId,
      name: 'Seeded group',
      normalizedName: 'seeded group',
      bookIds: members,
      deletedAt: null,
      ...timestampsFor(0),
    });
  }
  await WishlistItemModel.collection.insertMany(
    Array.from({ length: size.wishes }, (_unused, position) => ({
      ownerId,
      title: `Seeded wish ${position}`,
      normalizedTitle: `seeded wish ${position}`,
      authors: [],
      priority: ['high', 'medium', 'low'][position % 3],
      priorityRank: position % 3,
      status: position % 4 === 0 ? 'acquired' : 'wanted',
      acquiredBookId: position % 4 === 0 ? bookOf(position) : null,
      deletedAt: null,
      ...timestampsFor(position),
    })),
  );
  await LoanModel.collection.insertMany(
    Array.from({ length: size.loans }, (_unused, position) => {
      const isActive = position < size.copies && position % 2 === 0;
      return {
        ownerId,
        copyId: copyIds[position % copyIds.length],
        bookId: bookOf(position % copyIds.length),
        borrowerName: `Borrower ${position}`,
        lentOn: '2026-01-01',
        dueOn: '2026-02-01',
        returnedOn: isActive ? null : '2026-01-15',
        revision: 0,
        ...timestampsFor(position),
      };
    }),
  );
  return { bookIds, copyIds };
}
