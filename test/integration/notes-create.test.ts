import type { Express } from 'express';
import { describe, expect, it } from 'vitest';
import { NoteModel } from '../../src/modules/notes/note.model.js';
import { collectKeys, createAuthTestApp } from './auth-fixtures.js';
import {
  addEbook,
  addNote,
  addPhysicalBook,
  expectNotFound,
  invalidFieldsOf,
  noteFrom,
  signInLibraryReader,
  startSession,
  UNUSED_ID,
  type LibraryReader,
} from './library-fixtures.js';

const OBJECT_ID = /^[0-9a-f]{24}$/;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const INTERNAL_KEYS = ['_id', '__v', 'ownerId', 'userId', 'chapterKey', 'deletedAt'];

/** Prepares an id for a scenario, using the app and the reader under test. */
type ScenarioId = (app: Express, reader: LibraryReader) => Promise<string>;

async function signInWithBook() {
  const reader = await signInLibraryReader(createAuthTestApp());
  const book = await addPhysicalBook(reader);
  return { reader, book };
}

async function expectNoNotesStored() {
  expect(await NoteModel.countDocuments()).toBe(0);
}

async function finishSession(reader: LibraryReader, sessionId: string) {
  expect((await reader.reading.update(sessionId, { status: 'completed' })).status).toBe(200);
}

describe('POST /api/v1/books/:bookId/notes', () => {
  it('creates a minimal general note and returns exactly the public NoteDto', async () => {
    const { reader, book } = await signInWithBook();

    const res = await reader.notes.create(book.id, { kind: 'note', content: 'Bilbo hesitates.' });

    expect(res.status).toBe(201);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toEqual({
      data: {
        id: expect.stringMatching(OBJECT_ID),
        bookId: book.id,
        readingSessionId: null,
        kind: 'note',
        content: 'Bilbo hesitates.',
        createdAt: expect.stringMatching(ISO_TIMESTAMP),
        updatedAt: expect.stringMatching(ISO_TIMESTAMP),
      },
    });
    expect(res.headers.location).toBe(`/api/v1/notes/${noteFrom(res).id}`);
  });

  it('creates a highlight with every optional field for an ebook', async () => {
    const reader = await signInLibraryReader(createAuthTestApp());
    const ebook = await addEbook(reader);
    const session = await startSession(reader, ebook.id);

    const res = await reader.notes.create(ebook.id, {
      kind: 'highlight',
      content: 'Not all those who wander are lost.',
      title: 'Wandering',
      commentary: 'Reminds me of *my* travels.',
      chapter: 'Chapter 10',
      pageNumber: 167,
      readingSessionId: session.id,
    });

    expect(res.status).toBe(201);
    expect(noteFrom(res)).toEqual({
      id: expect.stringMatching(OBJECT_ID),
      bookId: ebook.id,
      readingSessionId: session.id,
      kind: 'highlight',
      content: 'Not all those who wander are lost.',
      title: 'Wandering',
      commentary: 'Reminds me of *my* travels.',
      chapter: 'Chapter 10',
      pageNumber: 167,
      createdAt: expect.stringMatching(ISO_TIMESTAMP),
      updatedAt: expect.stringMatching(ISO_TIMESTAMP),
    });
    const keys = collectKeys(res.body);
    for (const internalKey of INTERNAL_KEYS) expect(keys.has(internalKey)).toBe(false);
  });

  it('stores Markdown, raw HTML and quotations verbatim apart from surrounding whitespace', async () => {
    const { reader, book } = await signInWithBook();
    const markdown = '# Riddles\n\n- *in the dark*\n- [map](https://example.test)\n\n<b>raw</b>';
    const quotation = '“It’s a dangerous business,”  Frodo — going out your door…';

    const note = await addNote(reader, book.id, {
      kind: 'note',
      content: `\n\t ${markdown}  \n`,
      commentary: '  line one\n\n  line two  ',
      chapter: '  Chapter   Three ',
    });
    const highlight = await addNote(reader, book.id, { kind: 'highlight', content: quotation });

    expect(note.content).toBe(markdown);
    expect(note.commentary).toBe('line one\n\n  line two');
    expect(note.chapter).toBe('Chapter   Three');
    expect(highlight.content).toBe(quotation);
    expect((await reader.notes.get(note.id)).body.data.content).toBe(markdown);
    expect(await NoteModel.findById(note.id).lean()).toMatchObject({
      content: markdown,
      chapter: 'Chapter   Three',
      chapterKey: 'chapter three',
    });
  });

  it('accepts a note of 20,000 characters but a highlight of at most 5,000', async () => {
    const { reader, book } = await signInWithBook();

    const longNote = await reader.notes.create(book.id, {
      kind: 'note',
      content: 'n'.repeat(20_000),
    });
    const longestHighlight = await reader.notes.create(book.id, {
      kind: 'highlight',
      content: 'h'.repeat(5_000),
    });
    const tooLongHighlight = await reader.notes.create(book.id, {
      kind: 'highlight',
      content: 'h'.repeat(5_001),
    });

    expect(longNote.status).toBe(201);
    expect(longestHighlight.status).toBe(201);
    expect(tooLongHighlight.status).toBe(400);
    expect(tooLongHighlight.body.error.details).toEqual([
      { field: 'content', message: 'must be at most 5000 characters for a highlight' },
    ]);
  });

  describe('reading-session link', () => {
    it('stores a book-level note when the link is omitted or null', async () => {
      const { reader, book } = await signInWithBook();
      await startSession(reader, book.id);

      const omitted = await addNote(reader, book.id, { kind: 'note', content: 'General' });
      const explicitNull = await addNote(reader, book.id, {
        kind: 'note',
        content: 'Also general',
        readingSessionId: null,
      });

      expect(omitted.readingSessionId).toBeNull();
      expect(explicitNull.readingSessionId).toBeNull();
    });

    it('links to an in-progress, a completed or a reread session of the same book', async () => {
      const { reader, book } = await signInWithBook();
      const firstRead = await startSession(reader, book.id);
      await finishSession(reader, firstRead.id);
      const reread = await startSession(reader, book.id);

      const onFirstRead = await addNote(reader, book.id, {
        kind: 'highlight',
        content: 'From the first read',
        readingSessionId: firstRead.id,
      });
      const onReread = await addNote(reader, book.id, {
        kind: 'note',
        content: 'Different on the reread',
        readingSessionId: reread.id.toUpperCase(),
      });

      expect(onFirstRead.readingSessionId).toBe(firstRead.id);
      expect(onReread.readingSessionId).toBe(reread.id);
      await finishSession(reader, reread.id);
      expect((await reader.notes.get(onReread.id)).body.data.readingSessionId).toBe(reread.id);
    });

    it.each<[string, ScenarioId]>([
      ['an unknown session', () => Promise.resolve(UNUSED_ID)],
      [
        'another reader’s session',
        async (app) => {
          const otherReader = await signInLibraryReader(app);
          const otherBook = await addPhysicalBook(otherReader);
          return (await startSession(otherReader, otherBook.id)).id;
        },
      ],
      [
        'a session of the reader’s deleted book',
        async (_app, reader) => {
          const deletedBook = await addPhysicalBook(reader, 'Deleted');
          const session = await startSession(reader, deletedBook.id);
          expect((await reader.books.remove(deletedBook.id)).status).toBe(204);
          return session.id;
        },
      ],
    ])('responds 404 for %s and stores nothing', async (_label, sessionIdFor) => {
      const app = createAuthTestApp();
      const reader = await signInLibraryReader(app);
      const book = await addPhysicalBook(reader);
      const sessionId = await sessionIdFor(app, reader);

      const res = await reader.notes.create(book.id, {
        kind: 'note',
        content: 'Linked',
        readingSessionId: sessionId,
      });

      expectNotFound(res, 'Reading session not found');
      await expectNoNotesStored();
    });

    it('responds 409 for a session of another of the reader’s books and stores nothing', async () => {
      const { reader, book } = await signInWithBook();
      const otherBook = await addEbook(reader);
      const otherSession = await startSession(reader, otherBook.id);

      const res = await reader.notes.create(book.id, {
        kind: 'note',
        content: 'Wrong book',
        readingSessionId: otherSession.id,
      });

      expect(res.status).toBe(409);
      expect(res.body.error).toEqual({
        code: 'READING_SESSION_BOOK_MISMATCH',
        message: 'The reading session belongs to a different book',
        requestId: res.headers['x-request-id'],
      });
      await expectNoNotesStored();
    });

    it('rejects a malformed session id with 400 and stores nothing', async () => {
      const { reader, book } = await signInWithBook();

      const res = await reader.notes.create(book.id, {
        kind: 'note',
        content: 'Linked',
        readingSessionId: 'not-an-id',
      });

      expect(res.status).toBe(400);
      expect(res.body.error.details).toEqual([
        { field: 'readingSessionId', message: 'must be a 24-character hexadecimal id' },
      ]);
      await expectNoNotesStored();
    });
  });

  describe('parent book', () => {
    it.each<[string, ScenarioId]>([
      ['a missing book', () => Promise.resolve(UNUSED_ID)],
      [
        'another reader’s book',
        async (app) => {
          const otherReader = await signInLibraryReader(app);
          return (await addEbook(otherReader)).id;
        },
      ],
      [
        'a deleted book',
        async (_app, reader) => {
          const book = await addPhysicalBook(reader);
          expect((await reader.books.remove(book.id)).status).toBe(204);
          return book.id;
        },
      ],
    ])('responds 404 "Book not found" for %s and stores nothing', async (_label, bookIdFor) => {
      const app = createAuthTestApp();
      const reader = await signInLibraryReader(app);
      const bookId = await bookIdFor(app, reader);

      const res = await reader.notes.create(bookId, { kind: 'note', content: 'Orphan' });

      expectNotFound(res, 'Book not found');
      await expectNoNotesStored();
    });

    it('rejects a malformed book id with 400 naming bookId', async () => {
      const reader = await signInLibraryReader(createAuthTestApp());

      const res = await reader.notes.create('nope', { kind: 'note', content: 'Orphan' });

      expect(res.status).toBe(400);
      expect(res.body.error.details).toEqual([
        { field: 'bookId', message: 'must be a 24-character hexadecimal id' },
      ]);
    });
  });

  describe('validation', () => {
    it('rejects client-supplied ownership, identity and internal fields', async () => {
      const { reader, book } = await signInWithBook();

      const res = await reader.notes.create(book.id, {
        kind: 'note',
        content: 'Mine',
        ownerId: UNUSED_ID,
        bookId: UNUSED_ID,
        id: UNUSED_ID,
        chapterKey: 'x',
        deletedAt: null,
        createdAt: '2020-01-01T00:00:00.000Z',
      });

      expect(res.status).toBe(400);
      expect(res.body.error.details).toEqual(
        ['ownerId', 'bookId', 'id', 'chapterKey', 'deletedAt', 'createdAt'].map((field) => ({
          field,
          message: 'Unknown field',
        })),
      );
      await expectNoNotesStored();
    });

    it.each([
      ['a missing kind', { content: 'x' }, 'kind'],
      ['an unknown kind', { kind: 'quote', content: 'x' }, 'kind'],
      ['missing content', { kind: 'note' }, 'content'],
      ['blank content', { kind: 'note', content: ' \n\t ' }, 'content'],
      ['a blank title', { kind: 'note', content: 'x', title: '  ' }, 'title'],
      ['a too long title', { kind: 'note', content: 'x', title: 't'.repeat(161) }, 'title'],
      ['a blank chapter', { kind: 'note', content: 'x', chapter: ' ' }, 'chapter'],
      ['a too long chapter', { kind: 'note', content: 'x', chapter: 'c'.repeat(201) }, 'chapter'],
      ['blank commentary', { kind: 'note', content: 'x', commentary: '' }, 'commentary'],
      [
        'too long commentary',
        { kind: 'note', content: 'x', commentary: 'c'.repeat(5_001) },
        'commentary',
      ],
      ['page zero', { kind: 'note', content: 'x', pageNumber: 0 }, 'pageNumber'],
      ['a fractional page', { kind: 'note', content: 'x', pageNumber: 1.5 }, 'pageNumber'],
      ['a huge page', { kind: 'note', content: 'x', pageNumber: 100_001 }, 'pageNumber'],
      ['a null title', { kind: 'note', content: 'x', title: null }, 'title'],
    ])('rejects %s with 400 naming the field', async (_label, body, field) => {
      const { reader, book } = await signInWithBook();

      const res = await reader.notes.create(book.id, body);

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(invalidFieldsOf(res)).toEqual([field]);
      await expectNoNotesStored();
    });

    it('never echoes rejected content in the error response', async () => {
      const { reader, book } = await signInWithBook();
      const privateText = 'PRIVATE-QUOTE-MARKER ';

      const res = await reader.notes.create(book.id, {
        kind: 'highlight',
        content: privateText.repeat(300),
        title: `${privateText}`.repeat(10),
        pageNumber: privateText,
      });

      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).not.toContain('PRIVATE-QUOTE-MARKER');
    });
  });
});
