import mongoose from 'mongoose';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { createLogger } from '../../src/config/logger.js';
import { SessionModel } from '../../src/modules/auth/session.model.js';
import { BookModel } from '../../src/modules/books/book.model.js';
import { PhysicalCopyModel } from '../../src/modules/copies/copy.model.js';
import { LoanModel } from '../../src/modules/loans/loan.model.js';
import { NoteModel } from '../../src/modules/notes/note.model.js';
import { ReadingSessionModel } from '../../src/modules/reading/reading.model.js';
import { WishlistItemModel } from '../../src/modules/wishlist/wishlist.model.js';
import { createLogCapture } from '../helpers.js';
import { bearer, createAuthTestApp } from './auth-fixtures.js';
import { addBooksInEveryReadingState, EMPTY_SUMMARY } from './dashboard-fixtures.js';
import {
  activitiesFrom,
  addCopy,
  addNote,
  addPhysicalBook,
  addWish,
  lendCopy,
  readingStatisticsFrom,
  signInLibraryReader,
  startSession,
  summaryFrom,
  type LibraryReader,
} from './library-fixtures.js';

const DASHBOARD_PATHS = [
  '/api/v1/dashboard/summary',
  '/api/v1/dashboard/reading-statistics',
  '/api/v1/dashboard/recent-activity',
];
const LIBRARY_MODELS = [
  BookModel,
  PhysicalCopyModel,
  ReadingSessionModel,
  NoteModel,
  WishlistItemModel,
  LoanModel,
];

async function snapshotLibrary() {
  return Promise.all(
    LIBRARY_MODELS.map((model) => model.collection.find().sort({ _id: 1 }).toArray()),
  );
}

async function requestEveryDashboardView(reader: LibraryReader) {
  return Promise.all([
    reader.dashboard.summary(),
    reader.dashboard.summary({ asOf: '2026-11-14' }),
    reader.dashboard.readingStatistics(),
    reader.dashboard.recentActivity({ limit: '20' }),
  ]);
}

describe('dashboard authentication', () => {
  it.each([
    ['no token', undefined],
    ['an invalid token', 'Bearer aaa.bbb.ccc'],
  ])('rejects all three endpoints with %s', async (_label, authorization) => {
    const app = createAuthTestApp();

    for (const path of DASHBOARD_PATHS) {
      const pending = request(app).get(path);
      const res = await (authorization === undefined
        ? pending
        : pending.set('Authorization', authorization));
      expect(res.status).toBe(401);
      expect(res.headers['www-authenticate']).toBe('Bearer');
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body.error.code).toBe('UNAUTHENTICATED');
    }
  });

  it('rejects all three endpoints once the session is revoked', async () => {
    const app = createAuthTestApp();
    const reader = await signInLibraryReader(app);
    await SessionModel.updateMany(
      {},
      { $set: { revokedAt: new Date(), revocationReason: 'logout' } },
    );

    for (const path of DASHBOARD_PATHS) {
      const res = await request(app)
        .get(path)
        .set('Authorization', bearer(reader.tokens.accessToken));
      expect(res.status).toBe(401);
      expect(res.headers['cache-control']).toBe('no-store');
    }
  });

  it('sends no-store on validation errors too', async () => {
    const reader = await signInLibraryReader(createAuthTestApp());

    for (const res of [
      await reader.dashboard.summary({ asOf: 'x' }),
      await reader.dashboard.readingStatistics({ x: '1' }),
      await reader.dashboard.recentActivity({ limit: '0' }),
    ]) {
      expect(res.status).toBe(400);
      expect(res.headers['cache-control']).toBe('no-store');
    }
  });
});

describe('dashboard isolation', () => {
  it('never counts or lists another reader’s records, even through planted inconsistent rows', async () => {
    const app = createAuthTestApp();
    const reader = await signInLibraryReader(app);
    const other = await signInLibraryReader(app);
    const othersBook = await addPhysicalBook(other, 'Theirs');
    const othersCopy = await addCopy(other, othersBook.id);
    await startSession(other, othersBook.id, { status: 'completed' });
    await addNote(other, othersBook.id);
    await addWish(other);
    await lendCopy(other, othersCopy.id);
    const readersBook = await addPhysicalBook(reader, 'Mine');
    await ReadingSessionModel.create({
      ownerId: reader.userId,
      bookId: othersBook.id,
      status: 'completed',
    });
    await ReadingSessionModel.create({
      ownerId: other.userId,
      bookId: readersBook.id,
      status: 'in_progress',
    });
    await NoteModel.create({
      ownerId: reader.userId,
      bookId: othersBook.id,
      kind: 'note',
      content: 'x',
    });
    await NoteModel.create({
      ownerId: other.userId,
      bookId: readersBook.id,
      kind: 'highlight',
      content: 'x',
    });
    await PhysicalCopyModel.create({ ownerId: reader.userId, bookId: othersBook.id });
    await PhysicalCopyModel.create({ ownerId: other.userId, bookId: readersBook.id });
    await LoanModel.create({
      ownerId: other.userId,
      copyId: new mongoose.Types.ObjectId(),
      bookId: readersBook.id,
      borrowerName: 'Planted',
      lentOn: '2026-01-01',
      dueOn: '2026-01-02',
    });
    await WishlistItemModel.create({
      ownerId: other.userId,
      title: 'Planted',
      normalizedTitle: 'planted',
      priorityRank: 1,
    });

    const summary = summaryFrom(await reader.dashboard.summary({ asOf: '2026-11-14' }));
    const statistics = readingStatisticsFrom(await reader.dashboard.readingStatistics());
    const activities = activitiesFrom(await reader.dashboard.recentActivity({ limit: '20' }));

    expect(summary).toEqual({
      ...EMPTY_SUMMARY,
      asOf: '2026-11-14',
      catalogue: { ...EMPTY_SUMMARY.catalogue, totalBooks: 1, physicalBooks: 1 },
      reading: { ...EMPTY_SUMMARY.reading, unreadBooks: 1 },
    });
    expect(statistics.overall.sessions.total).toBe(0);
    expect(activities).toEqual([
      expect.objectContaining({ type: 'book_added', resourceId: readersBook.id }),
    ]);
  });
});

describe('dashboard reads', () => {
  afterEach(() => {
    mongoose.set('debug', false);
  });

  it('never changes any library record', async () => {
    const reader = await signInLibraryReader(createAuthTestApp());
    const books = await addBooksInEveryReadingState(reader);
    const copy = await addCopy(reader, books.unread.id);
    await lendCopy(reader, copy.id);
    await addNote(reader, books.reading.id);
    await addWish(reader);
    const before = await snapshotLibrary();

    for (const res of await requestEveryDashboardView(reader)) expect(res.status).toBe(200);

    expect(await snapshotLibrary()).toEqual(before);
  });

  it('issues the same number of queries whatever the size of the library', async () => {
    const queriesFor = async (bookCount: number) => {
      const reader = await signInLibraryReader(createAuthTestApp());
      for (let index = 0; index < bookCount; index += 1) {
        const book = await addPhysicalBook(reader, `Book ${index}`);
        await startSession(reader, book.id, { status: 'completed' });
        await addNote(reader, book.id);
        await lendCopy(reader, (await addCopy(reader, book.id)).id);
      }
      const operations: string[] = [];
      mongoose.set('debug', (collection: string, method: string) => {
        operations.push(`${collection}.${method}`);
      });
      for (const res of await requestEveryDashboardView(reader)) expect(res.status).toBe(200);
      mongoose.set('debug', false);
      return operations.sort();
    };

    const small = await queriesFor(1);
    const large = await queriesFor(12);

    expect(large).toEqual(small);
    expect(small.length).toBeGreaterThan(0);
  });
});

describe('dashboard logging', () => {
  it('never writes titles, notes, borrowers or query strings to the logs', async () => {
    const logs = createLogCapture();
    const reader = await signInLibraryReader(
      createAuthTestApp({ logger: createLogger('trace', logs.stream) }),
    );
    const book = await addPhysicalBook(reader, 'Secret Title');
    await addNote(reader, book.id, { kind: 'note', content: 'Secret thought' });
    await lendCopy(reader, (await addCopy(reader, book.id)).id, {
      borrowerName: 'Secret Borrower',
      lentOn: '1987-03-14',
    });
    await reader.dashboard.summary({ asOf: '1999-12-31' });
    await reader.dashboard.recentActivity({ limit: '7' });
    await reader.dashboard.summary({ asOf: 'not-a-date' });

    const output = logs.output();
    expect(output).toContain('"path":"/api/v1/dashboard/summary"');
    for (const privateText of [
      'Secret Title',
      'Secret thought',
      'Secret Borrower',
      '1999-12-31',
      'not-a-date',
      'asOf=',
      'limit=',
      reader.tokens.accessToken,
    ]) {
      expect(output).not.toContain(privateText);
    }
  });
});
