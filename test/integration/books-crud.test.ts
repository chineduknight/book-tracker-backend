import { describe, expect, it } from 'vitest';
import { BookModel } from '../../src/modules/books/book.model.js';
import { createAuthTestApp } from './auth-fixtures.js';
import {
  addBook,
  BOOK_DTO_KEYS,
  bookFrom,
  signInNewReader,
  UNUSED_BOOK_ID,
} from './book-fixtures.js';

const OBJECT_ID_HEX = /^[0-9a-f]{24}$/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const fullEbook = {
  title: '  The   Fellowship of the Ring ',
  authors: ['J. R. R. Tolkien'],
  format: 'ebook',
  isbn: '978-0 261-10235-7',
  edition: '50th anniversary',
  description: 'The first part of The Lord of the Rings.',
  coverUrl: 'https://covers.example.com/fellowship.jpg',
  pageCount: 423,
  chapterCount: 22,
  publicationYear: 1954,
};

describe('POST /api/v1/books', () => {
  it('creates a minimal physical book and omits unset optional fields', async () => {
    const { books } = await signInNewReader(createAuthTestApp());

    const res = await books.create({ title: 'Dune', format: 'physical' });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      data: {
        id: expect.stringMatching(OBJECT_ID_HEX),
        title: 'Dune',
        authors: [],
        format: 'physical',
        createdAt: expect.stringMatching(ISO_UTC),
        updatedAt: expect.stringMatching(ISO_UTC),
      },
    });
    expect(res.headers.location).toBe(`/api/v1/books/${bookFrom(res).id}`);
  });

  it('creates a full ebook entry with every public field and nothing internal', async () => {
    const { books, userId } = await signInNewReader(createAuthTestApp());

    const res = await books.create(fullEbook);

    expect(res.status).toBe(201);
    expect(bookFrom(res)).toEqual({
      ...fullEbook,
      title: 'The Fellowship of the Ring',
      isbn: '978-0 261-10235-7',
      id: expect.stringMatching(OBJECT_ID_HEX),
      createdAt: expect.stringMatching(ISO_UTC),
      updatedAt: expect.stringMatching(ISO_UTC),
    });
    expect(Object.keys(bookFrom(res)).sort()).toEqual([...BOOK_DTO_KEYS].sort());
    expect(res.text).not.toContain(userId);
    for (const internal of ['_id', '__v', 'ownerId', 'normalized', 'deletedAt']) {
      expect(res.text).not.toContain(internal);
    }
  });

  it('stores the owner from the access token and derived matching fields', async () => {
    const { books, userId } = await signInNewReader(createAuthTestApp());

    const book = await addBook(books, fullEbook);

    const stored = await BookModel.findById(book.id).lean();
    expect(stored?.ownerId.toHexString()).toBe(userId);
    expect(stored).toMatchObject({
      normalizedTitle: 'the fellowship of the ring',
      normalizedIsbn: '9780261102357',
      deletedAt: null,
    });
  });

  it('rejects forbidden and invalid fields with safe details', async () => {
    const { books } = await signInNewReader(createAuthTestApp());

    const res = await books.create({
      title: '',
      format: 'audiobook',
      ownerId: UNUSED_BOOK_ID,
      coverUrl: 'javascript:alert(1)',
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({
      code: 'VALIDATION_ERROR',
      message: 'The request contains invalid fields',
    });
    const fields = (res.body.error.details as { field: string }[]).map((detail) => detail.field);
    expect(fields.sort()).toEqual(['coverUrl', 'format', 'ownerId', 'title']);
    expect(res.text).not.toContain('javascript:alert');
    expect(await BookModel.countDocuments()).toBe(0);
  });
});

describe('GET /api/v1/books/:bookId', () => {
  it('returns the owner’s book', async () => {
    const { books } = await signInNewReader(createAuthTestApp());
    const book = await addBook(books, fullEbook);

    const res = await books.get(book.id);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: book });
  });

  it('accepts an uppercase hexadecimal id', async () => {
    const { books } = await signInNewReader(createAuthTestApp());
    const book = await addBook(books, { title: 'Dune', format: 'physical' });

    expect((await books.get(book.id.toUpperCase())).status).toBe(200);
  });

  it('rejects a malformed id with a bookId validation detail', async () => {
    const { books } = await signInNewReader(createAuthTestApp());

    const res = await books.get('not-a-book-id');

    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({
      code: 'VALIDATION_ERROR',
      details: [{ field: 'bookId', message: 'must be a 24-character hexadecimal id' }],
    });
    expect(res.text).not.toContain('not-a-book-id');
  });

  it('returns 404 NOT_FOUND for a valid id that does not exist', async () => {
    const { books } = await signInNewReader(createAuthTestApp());

    const res = await books.get(UNUSED_BOOK_ID);

    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      error: {
        code: 'NOT_FOUND',
        message: 'Book not found',
        requestId: res.headers['x-request-id'],
      },
    });
  });
});

describe('PATCH /api/v1/books/:bookId', () => {
  it('changes given fields, keeps omitted ones and clears explicit nulls', async () => {
    const { books, userId } = await signInNewReader(createAuthTestApp());
    const book = await addBook(books, fullEbook);

    const res = await books.update(book.id, {
      title: ' Fellowship  of the Ring ',
      format: 'physical',
      isbn: null,
      edition: null,
      description: null,
      coverUrl: null,
      pageCount: null,
      chapterCount: null,
      publicationYear: null,
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      data: {
        id: book.id,
        title: 'Fellowship of the Ring',
        authors: ['J. R. R. Tolkien'],
        format: 'physical',
        createdAt: book.createdAt,
        updatedAt: expect.stringMatching(ISO_UTC),
      },
    });
    const stored = await BookModel.findById(book.id).lean();
    expect(stored?.ownerId.toHexString()).toBe(userId);
    expect(stored?.normalizedTitle).toBe('fellowship of the ring');
    expect(stored).not.toHaveProperty('normalizedIsbn');
    expect(stored).not.toHaveProperty('isbn');
    expect(stored).not.toHaveProperty('pageCount');
  });

  it('clears authors with an empty list and updates the matching ISBN', async () => {
    const { books } = await signInNewReader(createAuthTestApp());
    const book = await addBook(books, fullEbook);

    const res = await books.update(book.id, { authors: [], isbn: '0-261-10235-x' });

    expect(bookFrom(res)).toMatchObject({ authors: [], isbn: '0-261-10235-x' });
    expect((await BookModel.findById(book.id).lean())?.normalizedIsbn).toBe('026110235X');
  });

  it.each<[string, object]>([
    ['an empty change set', {}],
    ['a forbidden owner field', { ownerId: UNUSED_BOOK_ID }],
    ['a forbidden deletion field', { deletedAt: null }],
    ['a null title', { title: null }],
    ['a blank optional field', { edition: '   ' }],
  ])('rejects %s and leaves the book unchanged', async (_label, changes) => {
    const { books } = await signInNewReader(createAuthTestApp());
    const book = await addBook(books, fullEbook);

    const res = await books.update(book.id, changes);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(bookFrom(await books.get(book.id))).toEqual(book);
  });

  it('returns 404 for a missing book', async () => {
    const { books } = await signInNewReader(createAuthTestApp());

    expect((await books.update(UNUSED_BOOK_ID, { title: 'Dune' })).status).toBe(404);
  });
});

describe('DELETE /api/v1/books/:bookId', () => {
  it('soft-deletes the book and hides it everywhere', async () => {
    const { books } = await signInNewReader(createAuthTestApp());
    const book = await addBook(books, fullEbook);

    const res = await books.remove(book.id);

    expect(res.status).toBe(204);
    expect(res.text).toBe('');
    expect((await books.get(book.id)).status).toBe(404);
    expect((await books.update(book.id, { title: 'Back' })).status).toBe(404);
    expect((await books.list()).body.meta.pagination.total).toBe(0);
    expect((await books.list({ q: 'fellowship' })).body.data).toEqual([]);
    expect(
      (await books.duplicateCheck({ title: fullEbook.title, isbn: fullEbook.isbn })).body.data
        .matches,
    ).toEqual([]);
    expect((await books.remove(book.id)).status).toBe(404);
  });

  it('keeps the record for future history instead of removing it', async () => {
    const { books } = await signInNewReader(createAuthTestApp());
    const book = await addBook(books, fullEbook);

    await books.remove(book.id);

    const stored = await BookModel.findById(book.id).lean();
    expect(stored?.deletedAt).toBeInstanceOf(Date);
    expect(stored?.title).toBe('The Fellowship of the Ring');
  });
});
