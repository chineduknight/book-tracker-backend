import { describe, expect, it } from 'vitest';
import { ReadingSessionModel } from '../../src/modules/reading/reading.model.js';
import { tallyReadingSessionsOfActiveBooks } from '../../src/modules/reading/reading.service.js';
import type { ReadingStatisticsCountsDto } from '../../src/modules/dashboard/dashboard.dto.js';
import { createAuthTestApp } from './auth-fixtures.js';
import { addBooksInEveryReadingState } from './dashboard-fixtures.js';
import {
  addNote,
  addPhysicalBook,
  invalidFieldsOf,
  overviewFrom,
  readingStatisticsFrom,
  signInLibraryReader,
  startSession,
  summaryFrom,
} from './library-fixtures.js';

function counts(
  books: ReadingStatisticsCountsDto['books'],
  sessions: ReadingStatisticsCountsDto['sessions'],
): ReadingStatisticsCountsDto {
  return { books, sessions };
}

const EMPTY = counts(
  { total: 0, unread: 0, reading: 0, completed: 0, everCompleted: 0 },
  { total: 0, inProgress: 0, completed: 0, rereads: 0 },
);

const EXPECTED_STATISTICS = {
  overall: counts(
    { total: 5, unread: 1, reading: 2, completed: 2, everCompleted: 3 },
    { total: 7, inProgress: 2, completed: 5, rereads: 3 },
  ),
  byFormat: {
    physical: counts(
      { total: 3, unread: 1, reading: 2, completed: 0, everCompleted: 1 },
      { total: 3, inProgress: 2, completed: 1, rereads: 1 },
    ),
    ebook: counts(
      { total: 2, unread: 0, reading: 0, completed: 2, everCompleted: 2 },
      { total: 4, inProgress: 0, completed: 4, rereads: 2 },
    ),
  },
};

function sumOf(first: ReadingStatisticsCountsDto, second: ReadingStatisticsCountsDto) {
  const add = <Counts extends Record<string, number>>(a: Counts, b: Counts) =>
    Object.fromEntries(Object.keys(a).map((key) => [key, (a[key] ?? 0) + (b[key] ?? 0)]));
  return { books: add(first.books, second.books), sessions: add(first.sessions, second.sessions) };
}

describe('GET /api/v1/dashboard/reading-statistics', () => {
  it('returns all zeros for a reader without books', async () => {
    const reader = await signInLibraryReader(createAuthTestApp());

    const res = await reader.dashboard.readingStatistics();

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toEqual({
      data: { overall: EMPTY, byFormat: { physical: EMPTY, ebook: EMPTY } },
    });
  });

  it('partitions books by current status and counts sessions, rereads and lifetime completions', async () => {
    const reader = await signInLibraryReader(createAuthTestApp());
    await addBooksInEveryReadingState(reader);

    const statistics = readingStatisticsFrom(await reader.dashboard.readingStatistics());

    expect(statistics).toEqual(EXPECTED_STATISTICS);
    expect(statistics.overall).toEqual(
      sumOf(statistics.byFormat.physical, statistics.byFormat.ebook),
    );
  });

  it('puts every book in the same bucket as its own reading overview', async () => {
    const reader = await signInLibraryReader(createAuthTestApp());
    const books = await addBooksInEveryReadingState(reader);

    const overviews = await Promise.all(
      Object.values(books).map(async (book) =>
        overviewFrom(await reader.reading.overview(book.id)),
      ),
    );
    const statusCounts = { unread: 0, reading: 0, completed: 0 };
    for (const overview of overviews) statusCounts[overview.status] += 1;

    const { overall } = readingStatisticsFrom(await reader.dashboard.readingStatistics());
    expect({
      unread: overall.books.unread,
      reading: overall.books.reading,
      completed: overall.books.completed,
    }).toEqual(statusCounts);
    expect(overviews.map((overview) => overview.status)).toEqual([
      'unread',
      'reading',
      'reading',
      'completed',
      'completed',
    ]);
    expect(overall.sessions.total).toBe(
      overviews.reduce((total, overview) => total + overview.totalSessions, 0),
    );
    expect(overall.sessions.completed).toBe(
      overviews.reduce((total, overview) => total + overview.completedSessions, 0),
    );
  });

  it('matches the reading counters of the summary exactly', async () => {
    const reader = await signInLibraryReader(createAuthTestApp());
    await addBooksInEveryReadingState(reader);

    const { overall } = readingStatisticsFrom(await reader.dashboard.readingStatistics());
    const { reading, catalogue } = summaryFrom(await reader.dashboard.summary());

    expect(reading).toEqual({
      unreadBooks: overall.books.unread,
      currentlyReadingBooks: overall.books.reading,
      completedBooks: overall.books.completed,
      booksEverCompleted: overall.books.everCompleted,
      totalSessions: overall.sessions.total,
      completedSessions: overall.sessions.completed,
      rereadSessions: overall.sessions.rereads,
    });
    expect(catalogue.totalBooks).toBe(overall.books.total);
  });

  it('ignores the sessions of deleted books and follows a book’s current format', async () => {
    const reader = await signInLibraryReader(createAuthTestApp());
    await addBooksInEveryReadingState(reader);
    const gone = await addPhysicalBook(reader, 'Gone');
    await startSession(reader, gone.id, { status: 'completed' });
    await startSession(reader, gone.id);
    await addNote(reader, gone.id);
    expect((await reader.books.remove(gone.id)).status).toBe(204);
    const switched = await addPhysicalBook(reader, 'Switched');
    await startSession(reader, switched.id, { status: 'completed' });
    expect((await reader.books.update(switched.id, { format: 'ebook' })).status).toBe(200);

    const statistics = readingStatisticsFrom(await reader.dashboard.readingStatistics());

    expect(statistics.overall.books).toEqual({
      total: 6,
      unread: 1,
      reading: 2,
      completed: 3,
      everCompleted: 4,
    });
    expect(statistics.byFormat.ebook.books.total).toBe(3);
    expect(statistics.byFormat.physical).toEqual(EXPECTED_STATISTICS.byFormat.physical);
    expect(statistics.overall.sessions).toEqual({
      total: 8,
      inProgress: 2,
      completed: 6,
      rereads: 3,
    });
  });

  it.each([
    ['asOf', { asOf: '2026-11-14' }, ['asOf']],
    ['any other parameter', { format: 'ebook' }, ['format']],
    ['several parameters', 'page=1&limit=2', ['page', 'limit']],
  ])('rejects %s with 400', async (_label, query, fields) => {
    const reader = await signInLibraryReader(createAuthTestApp());

    expect(invalidFieldsOf(await reader.dashboard.readingStatistics(query))).toEqual(fields);
  });
});

describe('tallyReadingSessionsOfActiveBooks', () => {
  it('tallies only the owner’s sessions of the owner’s active books, on its own', async () => {
    const app = createAuthTestApp();
    const reader = await signInLibraryReader(app);
    const other = await signInLibraryReader(app);
    const book = await addPhysicalBook(reader, 'Kept');
    await startSession(reader, book.id, { status: 'completed' });
    await startSession(reader, book.id);
    const deleted = await addPhysicalBook(reader, 'Deleted');
    await startSession(reader, deleted.id, { status: 'completed' });
    await reader.books.remove(deleted.id);
    const othersBook = await addPhysicalBook(other, 'Theirs');
    await ReadingSessionModel.create({
      ownerId: reader.userId,
      bookId: othersBook.id,
      status: 'completed',
    });
    await ReadingSessionModel.create({
      ownerId: other.userId,
      bookId: book.id,
      status: 'completed',
    });

    expect(await tallyReadingSessionsOfActiveBooks(reader.userId)).toEqual([
      { bookId: book.id, sessions: 2, completedSessions: 1, inProgressSessions: 1 },
    ]);
  });
});
