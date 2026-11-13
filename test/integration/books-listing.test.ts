import mongoose from 'mongoose';
import { describe, expect, it } from 'vitest';
import { BookModel } from '../../src/modules/books/book.model.js';
import { createAuthTestApp } from './auth-fixtures.js';
import {
  addBook,
  booksFrom,
  paginationFrom,
  signInNewReader,
  titlesFrom,
  type BooksApi,
} from './book-fixtures.js';

async function addBooksInOrder(books: BooksApi, entries: object[]) {
  const created = [];
  for (const entry of entries) created.push(await addBook(books, entry));
  return created;
}

describe('GET /api/v1/books pagination', () => {
  it('returns an empty first page for a new reader', async () => {
    const { books } = await signInNewReader(createAuthTestApp());

    const res = await books.list();

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      data: [],
      meta: { pagination: { page: 1, limit: 20, total: 0, totalPages: 0 } },
    });
  });

  it('pages through every book exactly once with stable metadata', async () => {
    const { books } = await signInNewReader(createAuthTestApp());
    const created = await addBooksInOrder(
      books,
      Array.from({ length: 7 }, (_, index) => ({ title: `Book ${index}`, format: 'physical' })),
    );

    const pages = [];
    for (const page of ['1', '2', '3']) pages.push(await books.list({ page, limit: '3' }));

    expect(pages.map(paginationFrom)).toEqual([
      { page: 1, limit: 3, total: 7, totalPages: 3 },
      { page: 2, limit: 3, total: 7, totalPages: 3 },
      { page: 3, limit: 3, total: 7, totalPages: 3 },
    ]);
    const seen = pages.flatMap((res) => booksFrom(res).map((book) => book.id));
    expect(seen).toEqual(created.map((book) => book.id).reverse());
    const beyond = await books.list({ page: '4', limit: '3' });
    expect(beyond.body).toEqual({
      data: [],
      meta: { pagination: { page: 4, limit: 3, total: 7, totalPages: 3 } },
    });
  });

  it.each([
    ['page=0', 'page'],
    ['limit=101', 'limit'],
    ['page=1&page=2', 'page'],
    ['sort=popular', 'sort'],
    ['format=audiobook', 'format'],
    ['ownerId=64b7f0c2a1b2c3d4e5f60718', 'ownerId'],
    ['q=%20%20', 'q'],
  ])('rejects ?%s with a %s detail', async (query, field) => {
    const { books } = await signInNewReader(createAuthTestApp());

    const res = await books.list(query);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details).toEqual([{ field, message: expect.any(String) }]);
  });
});

describe('GET /api/v1/books sorting', () => {
  it('supports every allowlisted sort with _id as the tie-breaker', async () => {
    const { books, userId } = await signInNewReader(createAuthTestApp());
    const created = await addBooksInOrder(books, [
      { title: 'beta', format: 'physical' },
      { title: 'Alpha', format: 'physical' },
      { title: 'alpha', format: 'physical' },
      { title: 'Gamma', format: 'physical' },
    ]);
    const sameInstant = new Date('2026-01-01T00:00:00.000Z');
    await BookModel.collection.updateMany(
      { ownerId: new mongoose.Types.ObjectId(userId) },
      { $set: { createdAt: sameInstant } },
    );
    const idsAscending = created.map((book) => book.id).sort();
    const titleOf = (id: string) => created.find((book) => book.id === id)?.title;

    expect(booksFrom(await books.list()).map((book) => book.id)).toEqual(
      [...idsAscending].reverse(),
    );
    expect(booksFrom(await books.list({ sort: 'oldest' })).map((book) => book.id)).toEqual(
      idsAscending,
    );
    const alphaIds = idsAscending.filter((id) => titleOf(id)?.toLowerCase() === 'alpha');
    expect(booksFrom(await books.list({ sort: 'title_asc' })).map((book) => book.id)).toEqual([
      ...alphaIds,
      created[0]?.id,
      created[3]?.id,
    ]);
    expect(booksFrom(await books.list({ sort: 'title_desc' })).map((book) => book.id)).toEqual([
      created[3]?.id,
      created[0]?.id,
      ...[...alphaIds].reverse(),
    ]);
  });

  it('orders recent and oldest by creation time', async () => {
    const { books } = await signInNewReader(createAuthTestApp());
    await addBooksInOrder(books, [
      { title: 'First', format: 'physical' },
      { title: 'Second', format: 'physical' },
      { title: 'Third', format: 'physical' },
    ]);

    expect(titlesFrom(await books.list())).toEqual(['Third', 'Second', 'First']);
    expect(titlesFrom(await books.list({ sort: 'oldest' }))).toEqual(['First', 'Second', 'Third']);
  });
});

describe('GET /api/v1/books search and filters', () => {
  async function seededLibrary() {
    const { books } = await signInNewReader(createAuthTestApp());
    await addBooksInOrder(books, [
      { title: 'The Hobbit', authors: ['J. R. R. Tolkien'], format: 'physical' },
      { title: 'The Silmarillion', authors: ['J. R. R. Tolkien'], format: 'ebook' },
      { title: 'Dune', authors: ['Frank Herbert'], format: 'ebook' },
      { title: 'Nausea', authors: ['Jean-Paul Sartre'], format: 'physical' },
      { title: 'It', authors: ['Stephen King'], format: 'physical' },
    ]);
    return books;
  }

  it('finds whole words in titles case-insensitively', async () => {
    const books = await seededLibrary();

    expect(titlesFrom(await books.list({ q: 'HOBBIT' }))).toEqual(['The Hobbit']);
    expect(titlesFrom(await books.list({ q: 'hob' }))).toEqual([]);
    expect(titlesFrom(await books.list({ q: 'it' }))).toEqual(['It']);
  });

  it('ignores diacritics when matching words', async () => {
    const { books } = await signInNewReader(createAuthTestApp());
    await addBook(books, { title: 'Café Society', format: 'physical' });

    expect(titlesFrom(await books.list({ q: 'cafe' }))).toEqual(['Café Society']);
    expect(titlesFrom(await books.list({ q: 'CAFÉ' }))).toEqual(['Café Society']);
  });

  it('finds words in author names, including hyphenated names', async () => {
    const books = await seededLibrary();

    expect(titlesFrom(await books.list({ q: 'tolkien', sort: 'title_asc' }))).toEqual([
      'The Hobbit',
      'The Silmarillion',
    ]);
    expect(titlesFrom(await books.list({ q: 'Jean-Paul' }))).toEqual(['Nausea']);
    expect(titlesFrom(await books.list({ q: 'paul' }))).toEqual(['Nausea']);
  });

  it('matches books containing any of the words and treats operators as plain text', async () => {
    const books = await seededLibrary();

    expect(titlesFrom(await books.list({ q: 'dune hobbit', sort: 'title_asc' }))).toEqual([
      'Dune',
      'The Hobbit',
    ]);
    expect(titlesFrom(await books.list({ q: '"dune" -hobbit', sort: 'title_asc' }))).toEqual([
      'Dune',
      'The Hobbit',
    ]);
  });

  it('combines search, format filter and pagination totals', async () => {
    const books = await seededLibrary();

    const res = await books.list({
      q: 'tolkien herbert',
      format: 'ebook',
      sort: 'title_asc',
      limit: '1',
    });

    expect(titlesFrom(res)).toEqual(['Dune']);
    expect(res.body.meta.pagination).toEqual({ page: 1, limit: 1, total: 2, totalPages: 2 });
  });

  it('filters by format', async () => {
    const books = await seededLibrary();

    expect(titlesFrom(await books.list({ format: 'ebook', sort: 'title_asc' }))).toEqual([
      'Dune',
      'The Silmarillion',
    ]);
  });
});
