import { describe, expect, it } from 'vitest';
import { NoteModel } from '../../src/modules/notes/note.model.js';
import { createAuthTestApp } from './auth-fixtures.js';
import {
  addEbook,
  addNote,
  addPhysicalBook,
  expectNotFound,
  invalidFieldsOf,
  notesFrom,
  paginationOf,
  signInLibraryReader,
  startSession,
  UNUSED_ID,
  type LibraryReader,
} from './library-fixtures.js';

const SAME_INSTANT = new Date('2026-01-01T00:00:00.000Z');

async function addNotes(reader: LibraryReader, bookId: string, count: number, kind = 'note') {
  const ids: string[] = [];
  for (let index = 0; index < count; index += 1) {
    ids.push((await addNote(reader, bookId, { kind, content: `Thought ${index}` })).id);
  }
  return ids;
}

function idsOf(res: { body: unknown }) {
  return notesFrom(res).map((note) => note.id);
}

describe('GET /api/v1/books/:bookId/notes', () => {
  it('lists one book’s notes newest first with pagination metadata', async () => {
    const reader = await signInLibraryReader(createAuthTestApp());
    const book = await addPhysicalBook(reader);
    const otherBook = await addEbook(reader);
    const ids = await addNotes(reader, book.id, 3);
    await addNotes(reader, otherBook.id, 2);

    const res = await reader.notes.listForBook(book.id);

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(idsOf(res)).toEqual([...ids].reverse());
    expect(paginationOf(res)).toEqual({ page: 1, limit: 20, total: 3, totalPages: 1 });
  });

  it('pages oldest first and returns an empty page past the end', async () => {
    const reader = await signInLibraryReader(createAuthTestApp());
    const book = await addPhysicalBook(reader);
    const ids = await addNotes(reader, book.id, 5);

    const pages = await Promise.all(
      ['1', '2', '3', '4'].map((page) =>
        reader.notes.listForBook(book.id, { sort: 'oldest', limit: '2', page }),
      ),
    );

    expect(pages.map(idsOf)).toEqual([ids.slice(0, 2), ids.slice(2, 4), ids.slice(4), []]);
    expect(paginationOf(pages[3] ?? { body: {} })).toEqual({
      page: 4,
      limit: 2,
      total: 5,
      totalPages: 3,
    });
  });

  it('returns an empty first page when the book has no notes', async () => {
    const reader = await signInLibraryReader(createAuthTestApp());
    const book = await addPhysicalBook(reader);

    const res = await reader.notes.listForBook(book.id);

    expect(res.body).toEqual({
      data: [],
      meta: { pagination: { page: 1, limit: 20, total: 0, totalPages: 0 } },
    });
  });

  it('breaks ties on identical creation times by id in the sort direction', async () => {
    const reader = await signInLibraryReader(createAuthTestApp());
    const book = await addPhysicalBook(reader);
    const ids = await addNotes(reader, book.id, 4);
    await NoteModel.updateMany({}, { $set: { createdAt: SAME_INSTANT } });
    const ascendingIds = [...ids].sort();

    const recent = await reader.notes.listForBook(book.id);
    const oldest = await reader.notes.listForBook(book.id, { sort: 'oldest' });
    const globalRecent = await reader.notes.listAll();

    expect(idsOf(recent)).toEqual([...ascendingIds].reverse());
    expect(idsOf(oldest)).toEqual(ascendingIds);
    expect(idsOf(globalRecent)).toEqual([...ascendingIds].reverse());
  });

  it('filters by kind, normalized chapter and reading session together', async () => {
    const reader = await signInLibraryReader(createAuthTestApp());
    const book = await addPhysicalBook(reader);
    const firstRead = await startSession(reader, book.id, { status: 'completed' });
    const reread = await startSession(reader, book.id);
    const match = await addNote(reader, book.id, {
      kind: 'highlight',
      content: 'Match',
      chapter: 'Café  Society',
      readingSessionId: reread.id,
    });
    await addNote(reader, book.id, {
      kind: 'note',
      content: 'Wrong kind',
      chapter: 'Café Society',
      readingSessionId: reread.id,
    });
    await addNote(reader, book.id, {
      kind: 'highlight',
      content: 'Wrong session',
      chapter: 'Café Society',
      readingSessionId: firstRead.id,
    });
    await addNote(reader, book.id, {
      kind: 'highlight',
      content: 'Wrong chapter',
      chapter: 'Café Society II',
      readingSessionId: reread.id,
    });

    const res = await reader.notes.listForBook(book.id, {
      kind: 'highlight',
      chapter: '  CAFÉ society ',
      readingSessionId: reread.id,
    });

    expect(idsOf(res)).toEqual([match.id]);
    expect(paginationOf(res).total).toBe(1);
  });

  it('responds 409 when the session filter belongs to another of the reader’s books', async () => {
    const reader = await signInLibraryReader(createAuthTestApp());
    const book = await addPhysicalBook(reader);
    const otherBook = await addEbook(reader);
    const otherSession = await startSession(reader, otherBook.id);

    const res = await reader.notes.listForBook(book.id, { readingSessionId: otherSession.id });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('READING_SESSION_BOOK_MISMATCH');
  });

  it('responds 404 for a missing, foreign or deleted book and an unknown session filter', async () => {
    const app = createAuthTestApp();
    const reader = await signInLibraryReader(app);
    const otherReader = await signInLibraryReader(app);
    const book = await addPhysicalBook(reader);
    const deletedBook = await addPhysicalBook(reader, 'Deleted');
    await reader.books.remove(deletedBook.id);
    const foreignBook = await addPhysicalBook(otherReader);
    const foreignSession = await startSession(otherReader, foreignBook.id);

    for (const bookId of [UNUSED_ID, foreignBook.id, deletedBook.id]) {
      expectNotFound(await reader.notes.listForBook(bookId), 'Book not found');
    }
    for (const readingSessionId of [UNUSED_ID, foreignSession.id]) {
      expectNotFound(
        await reader.notes.listForBook(book.id, { readingSessionId }),
        'Reading session not found',
      );
    }
  });

  it.each([
    ['an unknown parameter', { owner: 'me' }, ['owner']],
    ['bookId, which only the global list accepts', { bookId: UNUSED_ID }, ['bookId']],
    ['a repeated parameter', 'kind=note&kind=highlight', ['kind']],
    ['an unknown kind', { kind: 'quote' }, ['kind']],
    ['an unknown sort', { sort: 'score' }, ['sort']],
    ['a limit over 100', { limit: '101' }, ['limit']],
    ['page zero', { page: '0' }, ['page']],
    ['a malformed session id', { readingSessionId: 'abc' }, ['readingSessionId']],
    ['a blank chapter', { chapter: '   ' }, ['chapter']],
    ['a too long chapter', { chapter: 'c'.repeat(201) }, ['chapter']],
    ['a search without letters or digits', { q: '"--"' }, ['q']],
    ['a too long search', { q: 'q'.repeat(121) }, ['q']],
  ])('rejects %s with 400', async (_label, query, fields) => {
    const reader = await signInLibraryReader(createAuthTestApp());
    const book = await addPhysicalBook(reader);

    expect(invalidFieldsOf(await reader.notes.listForBook(book.id, query))).toEqual(fields);
  });
});

describe('GET /api/v1/notes', () => {
  it('lists notes across the reader’s books with exact totals and no gaps when books are deleted', async () => {
    const reader = await signInLibraryReader(createAuthTestApp());
    const books = await Promise.all(
      ['A', 'B', 'C', 'D'].map((title) => addPhysicalBook(reader, title)),
    );
    const visibleIds: string[] = [];
    for (let round = 0; round < 3; round += 1) {
      for (const [index, book] of books.entries()) {
        const note = await addNote(reader, book.id, {
          kind: round === 1 ? 'highlight' : 'note',
          content: `Dragon thought ${round}`,
        });
        if (index % 2 === 0) visibleIds.push(note.id);
      }
    }
    await reader.books.remove(books[1]?.id ?? '');
    await reader.books.remove(books[3]?.id ?? '');

    const pages = await Promise.all(
      ['1', '2', '3', '4'].map((page) => reader.notes.listAll({ limit: '2', page })),
    );

    expect(pages.flatMap(idsOf)).toEqual([...visibleIds].reverse());
    expect(pages.map((page) => idsOf(page).length)).toEqual([2, 2, 2, 0]);
    for (const page of pages) {
      expect(paginationOf(page)).toMatchObject({ total: 6, totalPages: 3 });
    }
    for (const [query, expectedTotal] of [
      [{ q: 'dragon', limit: '1' }, 6],
      [{ kind: 'highlight', limit: '1' }, 2],
      [{ q: 'thought', kind: 'note', limit: '1', page: '4' }, 4],
    ] as const) {
      const res = await reader.notes.listAll(query);
      expect(paginationOf(res)).toMatchObject({ total: expectedTotal });
      expect(idsOf(res)).toHaveLength(1);
    }
  });

  it('filters by book and by a reading session of any of the reader’s books', async () => {
    const reader = await signInLibraryReader(createAuthTestApp());
    const book = await addPhysicalBook(reader);
    const ebook = await addEbook(reader);
    const session = await startSession(reader, ebook.id);
    const bookNote = await addNote(reader, book.id);
    const sessionNote = await addNote(reader, ebook.id, {
      kind: 'highlight',
      content: 'Linked',
      readingSessionId: session.id,
    });
    await addNote(reader, ebook.id);

    expect(idsOf(await reader.notes.listAll({ bookId: book.id }))).toEqual([bookNote.id]);
    expect(idsOf(await reader.notes.listAll({ readingSessionId: session.id }))).toEqual([
      sessionNote.id,
    ]);
    expect(
      idsOf(await reader.notes.listAll({ bookId: ebook.id, readingSessionId: session.id })),
    ).toEqual([sessionNote.id]);
  });

  it('responds 409 when the book and session filters do not belong together', async () => {
    const reader = await signInLibraryReader(createAuthTestApp());
    const book = await addPhysicalBook(reader);
    const ebook = await addEbook(reader);
    const session = await startSession(reader, ebook.id);

    const res = await reader.notes.listAll({ bookId: book.id, readingSessionId: session.id });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('READING_SESSION_BOOK_MISMATCH');
  });

  it('responds 404 for foreign or deleted book and session filters instead of an empty page', async () => {
    const app = createAuthTestApp();
    const reader = await signInLibraryReader(app);
    const otherReader = await signInLibraryReader(app);
    const foreignBook = await addPhysicalBook(otherReader);
    const foreignSession = await startSession(otherReader, foreignBook.id);
    const deletedBook = await addPhysicalBook(reader);
    const sessionOfDeletedBook = await startSession(reader, deletedBook.id);
    await reader.books.remove(deletedBook.id);

    for (const bookId of [UNUSED_ID, foreignBook.id, deletedBook.id]) {
      expectNotFound(await reader.notes.listAll({ bookId }), 'Book not found');
    }
    for (const readingSessionId of [UNUSED_ID, foreignSession.id, sessionOfDeletedBook.id]) {
      expectNotFound(await reader.notes.listAll({ readingSessionId }), 'Reading session not found');
    }
  });

  it('returns an empty page for a reader without notes', async () => {
    const reader = await signInLibraryReader(createAuthTestApp());

    expect((await reader.notes.listAll()).body).toEqual({
      data: [],
      meta: { pagination: { page: 1, limit: 20, total: 0, totalPages: 0 } },
    });
  });

  it.each([
    ['a malformed book id', { bookId: 'abc' }, ['bookId']],
    ['a repeated book id', `bookId=${UNUSED_ID}&bookId=${UNUSED_ID}`, ['bookId']],
    ['an unknown parameter', { ownerId: UNUSED_ID }, ['ownerId']],
  ])('rejects %s with 400', async (_label, query, fields) => {
    const reader = await signInLibraryReader(createAuthTestApp());

    expect(invalidFieldsOf(await reader.notes.listAll(query))).toEqual(fields);
  });
});
