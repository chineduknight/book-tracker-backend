import { describe, expect, it } from 'vitest';
import { NoteModel } from '../../src/modules/notes/note.model.js';
import { createAuthTestApp } from './auth-fixtures.js';
import {
  addNote,
  addPhysicalBook,
  expectNotFound,
  invalidFieldsOf,
  noteFrom,
  notesFrom,
  paginationOf,
  signInLibraryReader,
  startSession,
  UNUSED_ID,
} from './library-fixtures.js';

const COMPLETE_NOTE = {
  kind: 'note',
  content: 'The riddle game is a contest of wits.',
  title: 'Riddles',
  commentary: 'Compare with the Sphinx.',
  chapter: 'Riddles in the Dark',
  pageNumber: 72,
};

async function signInWithNote(note: object = COMPLETE_NOTE) {
  const reader = await signInLibraryReader(createAuthTestApp());
  const book = await addPhysicalBook(reader);
  const created = await addNote(reader, book.id, note);
  return { reader, book, note: created };
}

function storedNote(noteId: string) {
  return NoteModel.findById(noteId).orFail().lean();
}

describe('GET /api/v1/notes/:noteId', () => {
  it('returns the reader’s note', async () => {
    const { reader, note } = await signInWithNote();

    const res = await reader.notes.get(note.id);

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toEqual({ data: note });
  });

  it('rejects a malformed id with 400 naming noteId', async () => {
    const { reader } = await signInWithNote();

    expect(invalidFieldsOf(await reader.notes.get('123'))).toEqual(['noteId']);
  });

  it('responds identically for missing, foreign and deleted notes', async () => {
    const app = createAuthTestApp();
    const reader = await signInLibraryReader(app);
    const otherReader = await signInLibraryReader(app);
    const book = await addPhysicalBook(reader);
    const deletedNote = await addNote(reader, book.id);
    await reader.notes.remove(deletedNote.id);
    const foreignNote = await addNote(otherReader, (await addPhysicalBook(otherReader)).id);

    for (const noteId of [UNUSED_ID, foreignNote.id, deletedNote.id]) {
      expectNotFound(await reader.notes.get(noteId), 'Note not found');
    }
  });
});

describe('PATCH /api/v1/notes/:noteId', () => {
  it('changes only the given fields and keeps every other field', async () => {
    const { reader, note } = await signInWithNote();

    const res = await reader.notes.update(note.id, { title: '  Riddles, revisited  ' });

    expect(res.status).toBe(200);
    expect(noteFrom(res)).toEqual({
      ...note,
      title: 'Riddles, revisited',
      updatedAt: expect.any(String),
    });
    expect(Date.parse(noteFrom(res).updatedAt)).toBeGreaterThanOrEqual(Date.parse(note.updatedAt));
  });

  it('clears optional fields with null and removes the internal chapter key', async () => {
    const { reader, note } = await signInWithNote();

    const res = await reader.notes.update(note.id, {
      title: null,
      commentary: null,
      chapter: null,
      pageNumber: null,
    });

    expect(res.status).toBe(200);
    expect(noteFrom(res)).toEqual({
      id: note.id,
      bookId: note.bookId,
      readingSessionId: null,
      kind: 'note',
      content: note.content,
      createdAt: note.createdAt,
      updatedAt: expect.any(String),
    });
    const stored = await storedNote(note.id);
    for (const cleared of ['title', 'commentary', 'chapter', 'chapterKey', 'pageNumber']) {
      expect(stored).not.toHaveProperty(cleared);
    }
  });

  it('recomputes the chapter key when the chapter label changes', async () => {
    const { reader, note } = await signInWithNote();

    await reader.notes.update(note.id, { chapter: '  An  UNEXPECTED Party ' });

    expect(await storedNote(note.id)).toMatchObject({
      chapter: 'An  UNEXPECTED Party',
      chapterKey: 'an unexpected party',
    });
  });

  it('keeps multiline content verbatim apart from surrounding whitespace', async () => {
    const { reader, note } = await signInWithNote();

    const res = await reader.notes.update(note.id, { content: '\n1. first\n2. *second*\n\n' });

    expect(noteFrom(res).content).toBe('1. first\n2. *second*');
  });

  it('applies the content limit of the note’s own kind', async () => {
    const app = createAuthTestApp();
    const reader = await signInLibraryReader(app);
    const book = await addPhysicalBook(reader);
    const note = await addNote(reader, book.id, { kind: 'note', content: 'short' });
    const highlight = await addNote(reader, book.id, { kind: 'highlight', content: 'short' });

    const longNote = await reader.notes.update(note.id, { content: 'n'.repeat(20_000) });
    const longHighlight = await reader.notes.update(highlight.id, { content: 'h'.repeat(5_001) });

    expect(longNote.status).toBe(200);
    expect(longHighlight.status).toBe(400);
    expect(longHighlight.body.error.details).toEqual([
      { field: 'content', message: 'must be at most 5000 characters for a highlight' },
    ]);
    expect((await storedNote(highlight.id)).content).toBe('short');
  });

  it('rejects an empty body', async () => {
    const { reader, note } = await signInWithNote();

    const res = await reader.notes.update(note.id, {});

    expect(res.status).toBe(400);
    expect(res.body.error.details).toEqual([
      { field: 'body', message: 'must change at least one field' },
    ]);
  });

  it('rejects changes to the kind, links, owner and lifecycle fields', async () => {
    const { reader, book, note } = await signInWithNote();
    const session = await startSession(reader, book.id);
    const forbidden = {
      kind: 'highlight',
      readingSessionId: session.id,
      bookId: UNUSED_ID,
      ownerId: UNUSED_ID,
      deletedAt: null,
      createdAt: '2020-01-01T00:00:00.000Z',
      chapterKey: 'x',
    };

    const res = await reader.notes.update(note.id, { ...forbidden, title: 'Ignored' });

    expect(invalidFieldsOf(res)).toEqual(Object.keys(forbidden));
    expect(await reader.notes.get(note.id)).toMatchObject({ body: { data: note } });
  });

  it('rejects clearing the content', async () => {
    const { reader, note } = await signInWithNote();

    expect(invalidFieldsOf(await reader.notes.update(note.id, { content: null }))).toEqual([
      'content',
    ]);
  });

  it('responds 404 for missing, foreign and deleted notes and changes nothing', async () => {
    const app = createAuthTestApp();
    const reader = await signInLibraryReader(app);
    const otherReader = await signInLibraryReader(app);
    const deletedNote = await addNote(reader, (await addPhysicalBook(reader)).id);
    await reader.notes.remove(deletedNote.id);
    const foreignNote = await addNote(otherReader, (await addPhysicalBook(otherReader)).id);

    for (const noteId of [UNUSED_ID, foreignNote.id, deletedNote.id]) {
      expectNotFound(await reader.notes.update(noteId, { title: 'Hijacked' }), 'Note not found');
    }
    expect(await storedNote(foreignNote.id)).not.toHaveProperty('title');
    expect(await storedNote(deletedNote.id)).not.toHaveProperty('title');
  });
});

describe('DELETE /api/v1/notes/:noteId', () => {
  it('soft-deletes the note: 204 with no body, the record is kept, and it disappears everywhere', async () => {
    const { reader, book, note } = await signInWithNote();

    const res = await reader.notes.remove(note.id);

    expect(res.status).toBe(204);
    expect(res.text).toBe('');
    expect(await storedNote(note.id)).toMatchObject({
      content: COMPLETE_NOTE.content,
      deletedAt: expect.any(Date),
    });
    expectNotFound(await reader.notes.get(note.id), 'Note not found');
    expectNotFound(await reader.notes.update(note.id, { title: 'Back' }), 'Note not found');
    expectNotFound(await reader.notes.remove(note.id), 'Note not found');
    for (const list of [
      await reader.notes.listForBook(book.id),
      await reader.notes.listAll(),
      await reader.notes.listAll({ q: 'riddle' }),
    ]) {
      expect(notesFrom(list)).toEqual([]);
      expect(paginationOf(list).total).toBe(0);
    }
  });

  it('responds 404 for a foreign note and leaves it untouched', async () => {
    const app = createAuthTestApp();
    const reader = await signInLibraryReader(app);
    const otherReader = await signInLibraryReader(app);
    const foreignNote = await addNote(otherReader, (await addPhysicalBook(otherReader)).id);

    expectNotFound(await reader.notes.remove(foreignNote.id), 'Note not found');
    expect((await storedNote(foreignNote.id)).deletedAt).toBeNull();
  });
});

describe('notes of a deleted book', () => {
  it('are hidden from every endpoint and kept unchanged in storage', async () => {
    const { reader, book, note } = await signInWithNote();
    const keptBook = await addPhysicalBook(reader, 'Kept');
    await addNote(reader, keptBook.id, { kind: 'note', content: 'The riddle stays visible' });
    const before = await storedNote(note.id);

    expect((await reader.books.remove(book.id)).status).toBe(204);

    expectNotFound(await reader.notes.get(note.id), 'Note not found');
    expectNotFound(await reader.notes.update(note.id, { title: 'x' }), 'Note not found');
    expectNotFound(await reader.notes.remove(note.id), 'Note not found');
    expectNotFound(await reader.notes.listForBook(book.id), 'Book not found');
    expectNotFound(await reader.notes.listAll({ bookId: book.id }), 'Book not found');
    for (const list of [
      await reader.notes.listAll(),
      await reader.notes.listAll({ q: 'riddle' }),
    ]) {
      expect(notesFrom(list).map((visible) => visible.bookId)).toEqual([keptBook.id]);
      expect(paginationOf(list)).toEqual({ page: 1, limit: 20, total: 1, totalPages: 1 });
    }
    expect(await storedNote(note.id)).toEqual(before);
  });
});

describe('notes linked to a reading session', () => {
  it('are not changed when the session is completed', async () => {
    const reader = await signInLibraryReader(createAuthTestApp());
    const book = await addPhysicalBook(reader);
    const session = await startSession(reader, book.id);
    const note = await addNote(reader, book.id, {
      kind: 'note',
      content: 'Mid-read thought',
      readingSessionId: session.id,
    });
    const before = await storedNote(note.id);

    await reader.reading.update(session.id, { status: 'completed' });

    expect(await storedNote(note.id)).toEqual(before);
  });
});
