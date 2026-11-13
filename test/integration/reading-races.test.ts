import { describe, expect, it } from 'vitest';
import { ReadingSessionModel } from '../../src/modules/reading/reading.model.js';
import { createAuthTestApp } from './auth-fixtures.js';
import {
  addPhysicalBook,
  expectNotFound,
  sessionFrom,
  signInLibraryReader,
  startSession,
} from './library-fixtures.js';

const ROUNDS = 20;

describe('reading session concurrency', () => {
  it('lets exactly one of 20 concurrent starts succeed for a book', async () => {
    const reader = await signInLibraryReader(createAuthTestApp());
    const book = await addPhysicalBook(reader);

    const responses = await Promise.all(
      Array.from({ length: 20 }, () => reader.reading.start(book.id)),
    );

    expect(responses.filter((res) => res.status === 201)).toHaveLength(1);
    const conflicts = responses.filter((res) => res.status === 409);
    expect(conflicts).toHaveLength(19);
    expect(new Set(conflicts.map((res) => res.body.error.code as string))).toEqual(
      new Set(['READING_SESSION_IN_PROGRESS']),
    );
    expect(await ReadingSessionModel.countDocuments({ status: 'in_progress' })).toBe(1);
  });

  it('never stores a completion date before the start date under concurrent edits', async () => {
    const reader = await signInLibraryReader(createAuthTestApp());
    const book = await addPhysicalBook(reader);

    for (let round = 0; round < ROUNDS; round += 1) {
      const session = await startSession(reader, book.id);
      const [laterStart, earlyFinish] = await Promise.all([
        reader.reading.update(session.id, { startedOn: '2026-06-01' }),
        reader.reading.update(session.id, { status: 'completed', completedOn: '2026-05-01' }),
      ]);

      const statuses = [laterStart.status, earlyFinish.status].sort();
      expect(statuses).toEqual([200, 400]);
      const stored = await ReadingSessionModel.findById(session.id).lean();
      const datesAreConsistent =
        stored?.startedOn == null ||
        stored.completedOn == null ||
        stored.completedOn >= stored.startedOn;
      expect(datesAreConsistent).toBe(true);
      if (stored?.status !== 'completed') {
        await reader.reading.update(session.id, { status: 'completed' });
      }
    }
  });

  it('never reopens a session that was finished concurrently', async () => {
    const reader = await signInLibraryReader(createAuthTestApp());
    const book = await addPhysicalBook(reader);

    for (let round = 0; round < ROUNDS; round += 1) {
      const session = await startSession(reader, book.id);
      const [finish, keepReading] = await Promise.all([
        reader.reading.update(session.id, { status: 'completed' }),
        reader.reading.update(session.id, {
          status: 'in_progress',
          progress: { unit: 'percent', value: round },
        }),
      ]);

      expect(finish.status).toBe(200);
      expect([200, 409]).toContain(keepReading.status);
      expect(sessionFrom(await reader.reading.get(session.id)).status).toBe('completed');
    }
    expect(await ReadingSessionModel.countDocuments({ status: 'in_progress' })).toBe(0);
  });

  it('keeps sessions created while their book is deleted hidden, and keeps history', async () => {
    const reader = await signInLibraryReader(createAuthTestApp());

    for (let round = 0; round < ROUNDS; round += 1) {
      const book = await addPhysicalBook(reader, `Race ${round}`);
      const earlier = await startSession(reader, book.id, { status: 'completed' });

      const [started, deletion] = await Promise.all([
        reader.reading.start(book.id),
        reader.books.remove(book.id),
      ]);

      expect(deletion.status).toBe(204);
      expect([201, 404]).toContain(started.status);
      if (started.status === 201) {
        expectNotFound(
          await reader.reading.get(sessionFrom(started).id),
          'Reading session not found',
        );
      }
      expectNotFound(await reader.reading.get(earlier.id), 'Reading session not found');
      expect(await ReadingSessionModel.exists({ _id: earlier.id })).not.toBeNull();
    }
    expect((await reader.reading.listAll()).body.meta.pagination.total).toBe(0);
  });
});
