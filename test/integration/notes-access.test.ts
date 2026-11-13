import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createLogger } from '../../src/config/logger.js';
import { SessionModel } from '../../src/modules/auth/session.model.js';
import { NoteModel } from '../../src/modules/notes/note.model.js';
import { createLogCapture } from '../helpers.js';
import { bearer, createAuthTestApp } from './auth-fixtures.js';
import {
  addNote,
  addPhysicalBook,
  expectNotFound,
  notesFrom,
  paginationOf,
  signInLibraryReader,
  startSession,
  type LibraryReader,
} from './library-fixtures.js';

function noteRequests(app: Parameters<typeof request>[0], bookId: string, noteId: string) {
  return [
    () => request(app).post(`/api/v1/books/${bookId}/notes`).send({ kind: 'note', content: 'x' }),
    () => request(app).get(`/api/v1/books/${bookId}/notes`),
    () => request(app).get('/api/v1/notes'),
    () => request(app).get(`/api/v1/notes/${noteId}`),
    () => request(app).patch(`/api/v1/notes/${noteId}`).send({ title: 'x' }),
    () => request(app).delete(`/api/v1/notes/${noteId}`),
  ];
}

async function expectInvisibleTo(reader: LibraryReader, noteId: string, readersBookId: string) {
  expectNotFound(await reader.notes.get(noteId), 'Note not found');
  expectNotFound(await reader.notes.update(noteId, { title: 'Changed' }), 'Note not found');
  expectNotFound(await reader.notes.remove(noteId), 'Note not found');
  for (const list of [
    await reader.notes.listAll(),
    await reader.notes.listAll({ q: 'planted' }),
    await reader.notes.listForBook(readersBookId),
  ]) {
    expect(list.status).toBe(200);
    expect(notesFrom(list).map((note) => note.id)).not.toContain(noteId);
  }
}

describe('note endpoint authentication', () => {
  it.each([
    ['no token', undefined],
    ['an invalid token', 'Bearer aaa.bbb.ccc'],
  ])('rejects all six endpoints with %s', async (_label, authorization) => {
    const app = createAuthTestApp();
    const reader = await signInLibraryReader(app);
    const book = await addPhysicalBook(reader);
    const note = await addNote(reader, book.id);

    for (const send of noteRequests(app, book.id, note.id)) {
      const pending = send();
      const res = await (authorization === undefined
        ? pending
        : pending.set('Authorization', authorization));
      expect(res.status).toBe(401);
      expect(res.headers['www-authenticate']).toBe('Bearer');
      expect(res.body.error.code).toBe('UNAUTHENTICATED');
    }
    expect(await NoteModel.countDocuments()).toBe(1);
  });

  it('rejects all six endpoints once the session is revoked', async () => {
    const app = createAuthTestApp();
    const reader = await signInLibraryReader(app);
    const book = await addPhysicalBook(reader);
    const note = await addNote(reader, book.id);
    await SessionModel.updateMany(
      {},
      { $set: { revokedAt: new Date(), revocationReason: 'logout' } },
    );

    for (const send of noteRequests(app, book.id, note.id)) {
      const res = await send().set('Authorization', bearer(reader.tokens.accessToken));
      expect(res.status).toBe(401);
      expect(res.headers['www-authenticate']).toBe('Bearer');
    }
    expect((await NoteModel.findById(note.id).orFail().lean()).deletedAt).toBeNull();
  });
});

describe('note ownership', () => {
  it('lets two readers keep identical notes without seeing or changing each other’s', async () => {
    const app = createAuthTestApp();
    const [first, second] = await Promise.all([signInLibraryReader(app), signInLibraryReader(app)]);
    const sameNote = { kind: 'highlight', content: 'Shared words', chapter: 'Chapter 1' };
    const firstBook = await addPhysicalBook(first);
    const firstNote = await addNote(first, firstBook.id, sameNote);
    const secondNote = await addNote(second, (await addPhysicalBook(second)).id, sameNote);

    await expectInvisibleTo(first, secondNote.id, firstBook.id);
    for (const query of [{}, { q: 'shared' }, { chapter: 'chapter 1' }, { kind: 'highlight' }]) {
      const res = await first.notes.listAll(query);
      expect(notesFrom(res).map((note) => note.id)).toEqual([firstNote.id]);
      expect(paginationOf(res).total).toBe(1);
    }
    expect((await second.notes.get(secondNote.id)).body.data).toEqual(secondNote);
  });

  it('hides a note whose owner differs from the reader even when its book is the reader’s', async () => {
    const app = createAuthTestApp();
    const reader = await signInLibraryReader(app);
    const otherReader = await signInLibraryReader(app);
    const readersBook = await addPhysicalBook(reader);
    const planted = await NoteModel.create({
      ownerId: otherReader.userId,
      bookId: readersBook.id,
      kind: 'note',
      content: 'planted note',
    });

    await expectInvisibleTo(reader, planted._id.toHexString(), readersBook.id);
    expect(await NoteModel.findById(planted._id).orFail().lean()).toMatchObject({
      deletedAt: null,
      content: 'planted note',
    });
  });

  it('hides the reader’s own note when its book belongs to someone else', async () => {
    const app = createAuthTestApp();
    const reader = await signInLibraryReader(app);
    const otherReader = await signInLibraryReader(app);
    const readersBook = await addPhysicalBook(reader);
    const othersBook = await addPhysicalBook(otherReader);
    const planted = await NoteModel.create({
      ownerId: reader.userId,
      bookId: othersBook.id,
      kind: 'note',
      content: 'planted note',
    });

    await expectInvisibleTo(reader, planted._id.toHexString(), readersBook.id);
  });

  it('never links a note to another reader’s session through a matching book id', async () => {
    const app = createAuthTestApp();
    const reader = await signInLibraryReader(app);
    const otherReader = await signInLibraryReader(app);
    const book = await addPhysicalBook(reader);
    const othersSession = await startSession(otherReader, (await addPhysicalBook(otherReader)).id);

    const res = await reader.notes.create(book.id, {
      kind: 'note',
      content: 'Linked',
      readingSessionId: othersSession.id,
    });

    expectNotFound(res, 'Reading session not found');
  });
});

describe('note logging', () => {
  it('never writes note text, quotations, commentary, chapters or searches to the logs', async () => {
    const logs = createLogCapture();
    const reader = await signInLibraryReader(
      createAuthTestApp({ logger: createLogger('trace', logs.stream) }),
    );
    const book = await addPhysicalBook(reader);
    const note = await addNote(reader, book.id, {
      kind: 'note',
      content: 'Confidential musing about grief',
      title: 'Hidden title',
      commentary: 'Personal commentary',
      chapter: 'Secret Chapter',
      pageNumber: 4321,
    });
    await addNote(reader, book.id, { kind: 'highlight', content: 'Quoted private passage' });
    await reader.notes.update(note.id, { content: 'Edited private musing' });
    await reader.notes.create(book.id, { kind: 'highlight', content: 'Rejected '.repeat(700) });
    await reader.notes.listAll({ q: 'musing grief', chapter: 'secret chapter' });
    await reader.notes.listForBook(book.id, { q: 'passage', kind: 'highlight' });

    const output = logs.output();
    expect(output).toContain('"path":"/api/v1/notes"');
    for (const privateText of [
      'Confidential',
      'grief',
      'Hidden title',
      'Personal commentary',
      'Secret Chapter',
      'secret chapter',
      '"pageNumber"',
      '"content"',
      'Quoted private',
      'Edited private',
      'Rejected',
      'musing',
      'passage',
      'q=',
      reader.tokens.accessToken,
    ]) {
      expect(output).not.toContain(privateText);
    }
  });
});
