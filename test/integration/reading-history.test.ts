import mongoose from 'mongoose';
import { describe, expect, it } from 'vitest';
import { ReadingSessionModel } from '../../src/modules/reading/reading.model.js';
import { createAuthTestApp } from './auth-fixtures.js';
import {
  addPhysicalBook,
  expectNotFound,
  paginationOf,
  sessionsFrom,
  signInLibraryReader,
  startSession,
  type LibraryReader,
} from './library-fixtures.js';

async function completedSessions(reader: LibraryReader, bookId: string, count: number) {
  const ids: string[] = [];
  for (let index = 0; index < count; index += 1) {
    ids.push((await startSession(reader, bookId, { status: 'completed' })).id);
  }
  return ids;
}

const idsOf = (res: { body: unknown }) => sessionsFrom(res).map((session) => session.id);

describe('GET /api/v1/books/:bookId/reading-sessions', () => {
  it('returns an empty page for a book that was never read', async () => {
    const reader = await signInLibraryReader(createAuthTestApp());
    const book = await addPhysicalBook(reader);

    expect((await reader.reading.listForBook(book.id)).body).toEqual({
      data: [],
      meta: { pagination: { page: 1, limit: 20, total: 0, totalPages: 0 } },
    });
  });

  it('pages, filters and sorts one book’s history', async () => {
    const reader = await signInLibraryReader(createAuthTestApp());
    const book = await addPhysicalBook(reader);
    const other = await addPhysicalBook(reader, 'Other');
    const completed = await completedSessions(reader, book.id, 3);
    const active = (await startSession(reader, book.id)).id;
    await completedSessions(reader, other.id, 2);
    const newestFirst = [active, ...[...completed].reverse()];

    const firstPage = await reader.reading.listForBook(book.id, { limit: '3' });
    const secondPage = await reader.reading.listForBook(book.id, { page: '2', limit: '3' });
    const oldest = await reader.reading.listForBook(book.id, { sort: 'oldest' });
    const onlyCompleted = await reader.reading.listForBook(book.id, { status: 'completed' });
    const onlyActive = await reader.reading.listForBook(book.id, { status: 'in_progress' });

    expect(idsOf(firstPage)).toEqual(newestFirst.slice(0, 3));
    expect(idsOf(secondPage)).toEqual(newestFirst.slice(3));
    expect(paginationOf(secondPage)).toEqual({ page: 2, limit: 3, total: 4, totalPages: 2 });
    expect(idsOf(oldest)).toEqual([...newestFirst].reverse());
    expect(idsOf(onlyCompleted)).toEqual([...completed].reverse());
    expect(idsOf(onlyActive)).toEqual([active]);
  });

  it('breaks ties on identical creation times by id', async () => {
    const reader = await signInLibraryReader(createAuthTestApp());
    const book = await addPhysicalBook(reader);
    const ids = await completedSessions(reader, book.id, 4);
    await ReadingSessionModel.collection.updateMany(
      { bookId: new mongoose.Types.ObjectId(book.id) },
      { $set: { createdAt: new Date('2026-01-01T00:00:00.000Z') } },
    );
    const ascending = [...ids].sort();

    expect(idsOf(await reader.reading.listForBook(book.id))).toEqual([...ascending].reverse());
    expect(idsOf(await reader.reading.listForBook(book.id, { sort: 'oldest' }))).toEqual(ascending);
  });

  it('returns 404 for a missing, deleted or foreign book', async () => {
    const app = createAuthTestApp();
    const jane = await signInLibraryReader(app);
    const omar = await signInLibraryReader(app);
    const book = await addPhysicalBook(jane);
    await completedSessions(jane, book.id, 1);

    expectNotFound(await omar.reading.listForBook(book.id), 'Book not found');
    await jane.books.remove(book.id);
    expectNotFound(await jane.reading.listForBook(book.id), 'Book not found');
  });

  it.each([
    ['status=reading'],
    ['status=completed&status=in_progress'],
    ['sort=title'],
    ['ownerId=x'],
  ])('rejects ?%s', async (query) => {
    const reader = await signInLibraryReader(createAuthTestApp());
    const book = await addPhysicalBook(reader);

    const res = await reader.reading.listForBook(book.id, query);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('GET /api/v1/reading-sessions', () => {
  it('lists the reader’s sessions across books with status filter and both sorts', async () => {
    const app = createAuthTestApp();
    const reader = await signInLibraryReader(app);
    const other = await signInLibraryReader(app);
    const hobbit = await addPhysicalBook(reader, 'The Hobbit');
    const dune = await addPhysicalBook(reader, 'Dune');
    const created = [
      (await startSession(reader, hobbit.id, { status: 'completed' })).id,
      (await startSession(reader, dune.id)).id,
      (await startSession(reader, hobbit.id)).id,
    ];
    await startSession(other, (await addPhysicalBook(other)).id);

    const recent = await reader.reading.listAll();
    const oldest = await reader.reading.listAll({ sort: 'oldest' });
    const active = await reader.reading.listAll({ status: 'in_progress' });

    expect(idsOf(recent)).toEqual([...created].reverse());
    expect(paginationOf(recent)).toEqual({ page: 1, limit: 20, total: 3, totalPages: 1 });
    expect(idsOf(oldest)).toEqual(created);
    expect(idsOf(active)).toEqual([created[2], created[1]]);
  });

  it('excludes sessions of deleted books before counting and paging', async () => {
    const reader = await signInLibraryReader(createAuthTestApp());
    const kept = await addPhysicalBook(reader, 'Kept');
    const deleted = await addPhysicalBook(reader, 'Deleted');
    const keptIds: string[] = [];
    for (let round = 0; round < 3; round += 1) {
      keptIds.push((await startSession(reader, kept.id, { status: 'completed' })).id);
      await startSession(reader, deleted.id, { status: 'completed' });
      await startSession(reader, deleted.id, { status: 'completed' });
    }
    await reader.books.remove(deleted.id);

    const firstPage = await reader.reading.listAll({ limit: '2' });
    const secondPage = await reader.reading.listAll({ page: '2', limit: '2' });
    const completed = await reader.reading.listAll({ status: 'completed', limit: '2' });

    expect(idsOf(firstPage)).toEqual([keptIds[2], keptIds[1]]);
    expect(idsOf(secondPage)).toEqual([keptIds[0]]);
    expect(paginationOf(firstPage)).toEqual({ page: 1, limit: 2, total: 3, totalPages: 2 });
    expect(paginationOf(completed).total).toBe(3);
    expect(await ReadingSessionModel.countDocuments()).toBe(9);
  });

  it('returns an empty first page and empty pages beyond the end', async () => {
    const reader = await signInLibraryReader(createAuthTestApp());

    expect((await reader.reading.listAll()).body).toEqual({
      data: [],
      meta: { pagination: { page: 1, limit: 20, total: 0, totalPages: 0 } },
    });
    await startSession(reader, (await addPhysicalBook(reader)).id);
    expect((await reader.reading.listAll({ page: '3' })).body).toEqual({
      data: [],
      meta: { pagination: { page: 3, limit: 20, total: 1, totalPages: 1 } },
    });
  });
});

describe('soft-deleted books', () => {
  it('keep every reading record but hide them from all reading endpoints', async () => {
    const reader = await signInLibraryReader(createAuthTestApp());
    const book = await addPhysicalBook(reader);
    const completed = await startSession(reader, book.id, { status: 'completed', summary: 'Kept' });
    const active = await startSession(reader, book.id);

    await reader.books.remove(book.id);

    for (const session of [completed, active]) {
      expectNotFound(await reader.reading.get(session.id), 'Reading session not found');
      expectNotFound(
        await reader.reading.update(session.id, { rating: 3 }),
        'Reading session not found',
      );
    }
    expectNotFound(await reader.reading.overview(book.id), 'Book not found');
    expectNotFound(await reader.reading.listForBook(book.id), 'Book not found');
    expectNotFound(await reader.reading.start(book.id), 'Book not found');
    expect(sessionsFrom(await reader.reading.listAll())).toEqual([]);
    const stored = await ReadingSessionModel.find().lean();
    expect(stored).toHaveLength(2);
    expect(stored.find((session) => session.summary === 'Kept')?.rating).toBeUndefined();
  });
});
