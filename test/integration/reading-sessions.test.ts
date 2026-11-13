import { describe, expect, it } from 'vitest';
import { ReadingSessionModel } from '../../src/modules/reading/reading.model.js';
import { createAuthTestApp } from './auth-fixtures.js';
import {
  addBookWithLengths,
  addEbook,
  addPhysicalBook,
  expectNotFound,
  sessionFrom,
  signInLibraryReader,
  startSession,
  UNUSED_ID,
} from './library-fixtures.js';

const OBJECT_ID_HEX = /^[0-9a-f]{24}$/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SESSION_DTO_KEYS = [
  'id',
  'bookId',
  'status',
  'progress',
  'startedOn',
  'completedOn',
  'rating',
  'summary',
  'createdAt',
  'updatedAt',
];

describe('POST /api/v1/books/:bookId/reading-sessions', () => {
  it('starts an in-progress session for a physical book with only public fields', async () => {
    const reader = await signInLibraryReader(createAuthTestApp());
    const book = await addPhysicalBook(reader);

    const res = await reader.reading.start(book.id, { startedOn: '2026-11-01' });

    expect(res.status).toBe(201);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers.location).toBe(`/api/v1/reading-sessions/${sessionFrom(res).id}`);
    expect(res.body).toEqual({
      data: {
        id: expect.stringMatching(OBJECT_ID_HEX),
        bookId: book.id,
        status: 'in_progress',
        progress: null,
        startedOn: '2026-11-01',
        createdAt: expect.stringMatching(ISO_UTC),
        updatedAt: expect.stringMatching(ISO_UTC),
      },
    });
    for (const internal of ['ownerId', '_id', '__v', 'revision']) {
      expect(res.text).not.toContain(internal);
    }
  });

  it('reads ebooks too and starts nothing just because a book was added', async () => {
    const reader = await signInLibraryReader(createAuthTestApp());
    const ebook = await addEbook(reader);
    await addPhysicalBook(reader);

    expect(await ReadingSessionModel.countDocuments()).toBe(0);
    expect((await reader.reading.start(ebook.id)).status).toBe(201);
  });

  it('records a completed read from years ago in one request, with no optional fields', async () => {
    const reader = await signInLibraryReader(createAuthTestApp());
    const book = await addPhysicalBook(reader);

    const session = await startSession(reader, book.id, { status: 'completed' });

    expect(session).toEqual({
      id: expect.stringMatching(OBJECT_ID_HEX),
      bookId: book.id,
      status: 'completed',
      progress: null,
      createdAt: expect.stringMatching(ISO_UTC),
      updatedAt: expect.stringMatching(ISO_UTC),
    });
  });

  it('stores every field of a fully described historic read exactly', async () => {
    const reader = await signInLibraryReader(createAuthTestApp());
    const book = await addPhysicalBook(reader);

    const session = await startSession(reader, book.id, {
      status: 'completed',
      progress: { unit: 'percent', value: 100 },
      startedOn: '1999-12-31',
      completedOn: '2000-02-29',
      rating: 4,
      summary: '  Slow start, wonderful ending. ',
    });

    expect(Object.keys(session).sort()).toEqual([...SESSION_DTO_KEYS].sort());
    expect(session).toMatchObject({
      startedOn: '1999-12-31',
      completedOn: '2000-02-29',
      rating: 4,
      summary: 'Slow start, wonderful ending.',
      progress: { unit: 'percent', value: 100 },
    });
  });

  it.each<[string, object, string]>([
    ['a completion date on an in-progress session', { completedOn: '2026-01-01' }, 'completedOn'],
    [
      'completion before the start',
      { status: 'completed', startedOn: '2026-02-01', completedOn: '2026-01-31' },
      'completedOn',
    ],
    ['an impossible date', { startedOn: '2026-02-30' }, 'startedOn'],
    ['a forbidden owner field', { ownerId: UNUSED_ID }, 'ownerId'],
    ['a reading status field', { readingStatus: 'reading' }, 'readingStatus'],
  ])('rejects %s', async (_label, body, field) => {
    const reader = await signInLibraryReader(createAuthTestApp());
    const book = await addPhysicalBook(reader);

    const res = await reader.reading.start(book.id, body);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect((res.body.error.details as { field: string }[]).map((detail) => detail.field)).toEqual([
      field,
    ]);
    expect(await ReadingSessionModel.countDocuments()).toBe(0);
  });

  it('validates progress against the book’s known page and chapter counts', async () => {
    const reader = await signInLibraryReader(createAuthTestApp());
    const measured = await addBookWithLengths(reader, { pageCount: 310, chapterCount: 19 });
    const unmeasured = await addPhysicalBook(reader, 'Unmeasured');

    const tooFar = await reader.reading.start(measured.id, {
      progress: { unit: 'pages', value: 311 },
    });
    const tooManyChapters = await reader.reading.start(measured.id, {
      progress: { unit: 'chapters', value: 20 },
    });
    const lastPage = await reader.reading.start(measured.id, {
      progress: { unit: 'pages', value: 310 },
    });
    const unknownLength = await reader.reading.start(unmeasured.id, {
      progress: { unit: 'pages', value: 5_000 },
    });

    expect(tooFar.body.error.details).toEqual([
      { field: 'progress.value', message: "must not exceed the book's page count" },
    ]);
    expect(tooManyChapters.body.error.details).toEqual([
      { field: 'progress.value', message: "must not exceed the book's chapter count" },
    ]);
    expect(sessionFrom(lastPage)).toMatchObject({
      status: 'in_progress',
      progress: { unit: 'pages', value: 310 },
    });
    expect(unknownLength.status).toBe(201);
  });

  it('refuses a second in-progress session for the same book', async () => {
    const reader = await signInLibraryReader(createAuthTestApp());
    const book = await addPhysicalBook(reader);
    await startSession(reader, book.id);

    const res = await reader.reading.start(book.id);

    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: {
        code: 'READING_SESSION_IN_PROGRESS',
        message: 'This book already has a reading session in progress',
        requestId: res.headers['x-request-id'],
      },
    });
  });

  it('allows completed history entries while a session is in progress', async () => {
    const reader = await signInLibraryReader(createAuthTestApp());
    const book = await addPhysicalBook(reader);
    await startSession(reader, book.id);

    expect((await reader.reading.start(book.id, { status: 'completed' })).status).toBe(201);
    expect((await reader.reading.start(book.id, { status: 'completed' })).status).toBe(201);
  });

  it('returns the same 404 for a missing, deleted or foreign book', async () => {
    const app = createAuthTestApp();
    const jane = await signInLibraryReader(app);
    const omar = await signInLibraryReader(app);
    const deleted = await addPhysicalBook(jane, 'Deleted');
    await jane.books.remove(deleted.id);
    const omarsBook = await addPhysicalBook(omar);

    for (const bookId of [UNUSED_ID, deleted.id, omarsBook.id]) {
      expectNotFound(await jane.reading.start(bookId), 'Book not found');
    }
    expect(await ReadingSessionModel.countDocuments()).toBe(0);
  });
});

describe('PATCH /api/v1/reading-sessions/:sessionId', () => {
  it('records progress without completing the session, even at 100%', async () => {
    const reader = await signInLibraryReader(createAuthTestApp());
    const book = await addBookWithLengths(reader, { pageCount: 310 });
    const session = await startSession(reader, book.id);

    const lastPage = await reader.reading.update(session.id, {
      progress: { unit: 'pages', value: 310 },
    });
    const corrected = await reader.reading.update(session.id, {
      progress: { unit: 'percent', value: 40 },
    });

    expect(sessionFrom(lastPage)).toMatchObject({
      status: 'in_progress',
      progress: { unit: 'pages', value: 310 },
    });
    expect(sessionFrom(corrected)).toMatchObject({
      status: 'in_progress',
      progress: { unit: 'percent', value: 40 },
    });
  });

  it('finishes a session without inventing a completion date', async () => {
    const reader = await signInLibraryReader(createAuthTestApp());
    const book = await addPhysicalBook(reader);
    const session = await startSession(reader, book.id, { startedOn: '2026-10-01' });

    const res = await reader.reading.update(session.id, { status: 'completed', rating: 5 });

    expect(sessionFrom(res)).toEqual({
      ...session,
      status: 'completed',
      rating: 5,
      updatedAt: expect.stringMatching(ISO_UTC),
    });
    expect(sessionFrom(res)).not.toHaveProperty('completedOn');
  });

  it('applies partial changes and clears explicit nulls', async () => {
    const reader = await signInLibraryReader(createAuthTestApp());
    const book = await addPhysicalBook(reader);
    const session = await startSession(reader, book.id, {
      status: 'completed',
      progress: { unit: 'chapters', value: 3 },
      startedOn: '2026-01-01',
      completedOn: '2026-01-31',
      rating: 3,
      summary: 'Fine.',
    });

    const cleared = await reader.reading.update(session.id, {
      progress: null,
      startedOn: null,
      completedOn: null,
      rating: null,
      summary: null,
    });

    expect(sessionFrom(cleared)).toEqual({
      id: session.id,
      bookId: book.id,
      status: 'completed',
      progress: null,
      createdAt: session.createdAt,
      updatedAt: expect.stringMatching(ISO_UTC),
    });
  });

  it('validates the merged dates rather than only the request', async () => {
    const reader = await signInLibraryReader(createAuthTestApp());
    const book = await addPhysicalBook(reader);
    const active = await startSession(reader, book.id, { startedOn: '2026-05-10' });

    const earlyFinish = await reader.reading.update(active.id, {
      status: 'completed',
      completedOn: '2026-05-09',
    });
    const dateWithoutFinishing = await reader.reading.update(active.id, {
      completedOn: '2026-05-20',
    });
    const finished = await reader.reading.update(active.id, {
      status: 'completed',
      completedOn: '2026-05-10',
    });
    const startAfterFinish = await reader.reading.update(active.id, { startedOn: '2026-05-11' });

    expect(earlyFinish.body.error.details).toEqual([
      { field: 'completedOn', message: 'must be on or after startedOn' },
    ]);
    expect(dateWithoutFinishing.body.error.details).toEqual([
      { field: 'completedOn', message: 'can only be set on a completed reading session' },
    ]);
    expect(sessionFrom(finished)).toMatchObject({
      startedOn: '2026-05-10',
      completedOn: '2026-05-10',
    });
    expect(startAfterFinish.status).toBe(400);
    expect(sessionFrom(await reader.reading.get(active.id))).toMatchObject({
      startedOn: '2026-05-10',
    });
  });

  it('never reopens a completed session', async () => {
    const reader = await signInLibraryReader(createAuthTestApp());
    const book = await addPhysicalBook(reader);
    const session = await startSession(reader, book.id, { status: 'completed', rating: 4 });

    const res = await reader.reading.update(session.id, { status: 'in_progress' });
    const correction = await reader.reading.update(session.id, {
      rating: 5,
      summary: 'Better on reflection.',
    });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: {
        code: 'INVALID_READING_TRANSITION',
        message:
          'A completed reading session cannot be reopened; start a new session to reread the book',
        requestId: res.headers['x-request-id'],
      },
    });
    expect(sessionFrom(correction)).toMatchObject({ status: 'completed', rating: 5 });
  });

  it('keeps old progress when the book’s page count later shrinks, but validates new progress', async () => {
    const reader = await signInLibraryReader(createAuthTestApp());
    const book = await addBookWithLengths(reader, { pageCount: 500 });
    const session = await startSession(reader, book.id, {
      progress: { unit: 'pages', value: 450 },
    });
    await reader.books.update(book.id, { pageCount: 300 });

    const unrelatedChange = await reader.reading.update(session.id, { startedOn: '2026-01-01' });
    const newProgress = await reader.reading.update(session.id, {
      progress: { unit: 'pages', value: 400 },
    });

    expect(sessionFrom(unrelatedChange).progress).toEqual({ unit: 'pages', value: 450 });
    expect(newProgress.status).toBe(400);
  });

  it.each<[string, object]>([
    ['an empty change set', {}],
    ['a null status', { status: null }],
    ['moving the session to another book', { bookId: UNUSED_ID }],
    ['an unknown status', { status: 'paused' }],
  ])('rejects %s', async (_label, changes) => {
    const reader = await signInLibraryReader(createAuthTestApp());
    const book = await addPhysicalBook(reader);
    const session = await startSession(reader, book.id);

    const res = await reader.reading.update(session.id, changes);

    expect(res.status).toBe(400);
    expect(sessionFrom(await reader.reading.get(session.id))).toEqual(session);
  });
});

describe('rereading', () => {
  it('starts a new session after finishing and leaves the earlier one untouched', async () => {
    const reader = await signInLibraryReader(createAuthTestApp());
    const book = await addPhysicalBook(reader);
    const first = await startSession(reader, book.id, { startedOn: '2025-01-01' });
    const finishedFirst = sessionFrom(
      await reader.reading.update(first.id, {
        status: 'completed',
        completedOn: '2025-02-01',
        rating: 4,
      }),
    );

    const reread = await startSession(reader, book.id, { startedOn: '2026-01-01' });
    const finishedReread = sessionFrom(
      await reader.reading.update(reread.id, { status: 'completed', rating: 5 }),
    );

    expect(reread.id).not.toBe(first.id);
    expect(sessionFrom(await reader.reading.get(first.id))).toEqual(finishedFirst);
    expect(finishedReread).toMatchObject({
      status: 'completed',
      rating: 5,
      startedOn: '2026-01-01',
    });
    expect(await ReadingSessionModel.countDocuments({ status: 'completed' })).toBe(2);
  });
});

describe('GET /api/v1/reading-sessions/:sessionId visibility', () => {
  it('hides another reader’s session behind the same 404 as a missing one', async () => {
    const app = createAuthTestApp();
    const jane = await signInLibraryReader(app);
    const omar = await signInLibraryReader(app);
    const session = await startSession(jane, (await addPhysicalBook(jane)).id, { summary: 'Mine' });

    for (const sessionId of [session.id, UNUSED_ID]) {
      expectNotFound(await omar.reading.get(sessionId), 'Reading session not found');
      expectNotFound(
        await omar.reading.update(sessionId, { summary: 'Stolen' }),
        'Reading session not found',
      );
    }
    expect(sessionFrom(await jane.reading.get(session.id))).toEqual(session);
  });

  it('requires the session itself to belong to the reader, not only its book', async () => {
    const app = createAuthTestApp();
    const jane = await signInLibraryReader(app);
    const omar = await signInLibraryReader(app);
    const janesBook = await addPhysicalBook(jane);
    const inconsistent = await new ReadingSessionModel({
      ownerId: omar.userId,
      bookId: janesBook.id,
      status: 'completed',
      summary: 'Omar’s private summary',
    }).save();

    expectNotFound(await jane.reading.get(inconsistent.id), 'Reading session not found');
    expectNotFound(
      await jane.reading.update(inconsistent.id, { rating: 1 }),
      'Reading session not found',
    );
    expect((await jane.reading.listForBook(janesBook.id)).body.data).toEqual([]);
    expect((await jane.reading.listAll()).body.data).toEqual([]);
    expect((await ReadingSessionModel.findById(inconsistent.id).lean())?.rating).toBeUndefined();
  });

  it('rejects malformed ids', async () => {
    const reader = await signInLibraryReader(createAuthTestApp());

    const res = await reader.reading.get('session-1');

    expect(res.status).toBe(400);
    expect(res.body.error.details).toEqual([
      { field: 'sessionId', message: 'must be a 24-character hexadecimal id' },
    ]);
  });
});
