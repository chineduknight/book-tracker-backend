import mongoose from 'mongoose';
import { describe, expect, it } from 'vitest';
import { ReadingSessionModel } from '../../src/modules/reading/reading.model.js';
import { createAuthTestApp } from './auth-fixtures.js';
import {
  addEbook,
  addPhysicalBook,
  expectNotFound,
  overviewFrom,
  sessionFrom,
  signInLibraryReader,
  startSession,
} from './library-fixtures.js';

describe('GET /api/v1/books/:bookId/reading-overview', () => {
  it('derives unread, reading, completed and reading again from the sessions', async () => {
    const reader = await signInLibraryReader(createAuthTestApp());
    const book = await addPhysicalBook(reader);

    const unread = overviewFrom(await reader.reading.overview(book.id));
    const first = await startSession(reader, book.id, { startedOn: '2025-01-01' });
    const reading = overviewFrom(await reader.reading.overview(book.id));
    const firstFinished = sessionFrom(
      await reader.reading.update(first.id, { status: 'completed', rating: 4 }),
    );
    const completed = overviewFrom(await reader.reading.overview(book.id));
    const reread = await startSession(reader, book.id);
    const readingAgain = overviewFrom(await reader.reading.overview(book.id));

    expect(unread).toEqual({
      bookId: book.id,
      status: 'unread',
      totalSessions: 0,
      completedSessions: 0,
      activeSession: null,
      lastCompletedSession: null,
    });
    expect(reading).toEqual({
      bookId: book.id,
      status: 'reading',
      totalSessions: 1,
      completedSessions: 0,
      activeSession: first,
      lastCompletedSession: null,
    });
    expect(completed).toMatchObject({
      status: 'completed',
      totalSessions: 1,
      completedSessions: 1,
      activeSession: null,
      lastCompletedSession: firstFinished,
    });
    expect(readingAgain).toEqual({
      bookId: book.id,
      status: 'reading',
      totalSessions: 2,
      completedSessions: 1,
      activeSession: reread,
      lastCompletedSession: firstFinished,
    });
  });

  it('picks the most recently created completed session, with id as tie-breaker', async () => {
    const reader = await signInLibraryReader(createAuthTestApp());
    const book = await addEbook(reader);
    const sessions = [];
    for (const completedOn of ['2026-01-01', '2020-01-01', '2023-06-01']) {
      sessions.push(await startSession(reader, book.id, { status: 'completed', completedOn }));
    }

    expect(overviewFrom(await reader.reading.overview(book.id)).lastCompletedSession?.id).toBe(
      sessions[2]?.id,
    );

    await ReadingSessionModel.collection.updateMany(
      { bookId: new mongoose.Types.ObjectId(book.id) },
      { $set: { createdAt: new Date('2026-01-01T00:00:00.000Z') } },
    );
    const highestId = sessions
      .map((session) => session.id)
      .sort()
      .at(-1);
    expect(overviewFrom(await reader.reading.overview(book.id)).lastCompletedSession?.id).toBe(
      highestId,
    );
  });

  it('never counts another reader’s sessions and hides foreign books', async () => {
    const app = createAuthTestApp();
    const jane = await signInLibraryReader(app);
    const omar = await signInLibraryReader(app);
    const janesBook = await addPhysicalBook(jane);
    await startSession(jane, janesBook.id, { status: 'completed' });
    const omarsBook = await addPhysicalBook(omar);

    expectNotFound(await omar.reading.overview(janesBook.id), 'Book not found');
    expect(overviewFrom(await omar.reading.overview(omarsBook.id))).toMatchObject({
      status: 'unread',
      totalSessions: 0,
    });
  });
});
