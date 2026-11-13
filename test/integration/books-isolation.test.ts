import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { SessionModel } from '../../src/modules/auth/session.model.js';
import { BookModel } from '../../src/modules/books/book.model.js';
import { bearer, createAuthTestApp } from './auth-fixtures.js';
import { addBook, bookFrom, signInNewReader, UNUSED_BOOK_ID } from './book-fixtures.js';

const sharedBook = {
  title: 'Shared Title',
  authors: ['Common Author'],
  format: 'physical',
  isbn: '978-1-23456-789-7',
};

describe('book ownership isolation', () => {
  it('hides another reader’s book behind the same 404 as a missing book', async () => {
    const app = createAuthTestApp();
    const jane = await signInNewReader(app);
    const omar = await signInNewReader(app);
    const janesBook = await addBook(jane.books, sharedBook);

    const foreignResponses = await Promise.all([
      omar.books.get(janesBook.id),
      omar.books.update(janesBook.id, { title: 'Stolen' }),
      omar.books.remove(janesBook.id),
    ]);
    const missingResponses = await Promise.all([
      omar.books.get(UNUSED_BOOK_ID),
      omar.books.update(UNUSED_BOOK_ID, { title: 'Stolen' }),
      omar.books.remove(UNUSED_BOOK_ID),
    ]);

    for (const [index, foreign] of foreignResponses.entries()) {
      const missing = missingResponses[index];
      expect(foreign.status).toBe(404);
      expect(foreign.body.error).toEqual({
        ...missing?.body.error,
        requestId: foreign.headers['x-request-id'],
      });
    }
    expect(bookFrom(await jane.books.get(janesBook.id))).toEqual(janesBook);
  });

  it('never lists, searches or suggests another reader’s books', async () => {
    const app = createAuthTestApp();
    const jane = await signInNewReader(app);
    const omar = await signInNewReader(app);
    await addBook(jane.books, sharedBook);

    expect((await omar.books.list()).body).toEqual({
      data: [],
      meta: { pagination: { page: 1, limit: 20, total: 0, totalPages: 0 } },
    });
    expect((await omar.books.list({ q: 'shared author' })).body.data).toEqual([]);
    expect((await omar.books.list({ format: 'physical' })).body.data).toEqual([]);
    const suggestions = await omar.books.duplicateCheck({
      title: sharedBook.title,
      isbn: sharedBook.isbn,
    });
    expect(suggestions.body.data.matches).toEqual([]);
  });

  it('cannot move a book to another owner through the request', async () => {
    const app = createAuthTestApp();
    const jane = await signInNewReader(app);
    const omar = await signInNewReader(app);
    const janesBook = await addBook(jane.books, sharedBook);

    const res = await jane.books.update(janesBook.id, { ownerId: omar.userId });

    expect(res.status).toBe(400);
    expect((await BookModel.findById(janesBook.id).lean())?.ownerId.toHexString()).toBe(
      jane.userId,
    );
  });

  it('keeps concurrent cross-reader writes isolated', async () => {
    const app = createAuthTestApp();
    const jane = await signInNewReader(app);
    const omar = await signInNewReader(app);
    const janesBooks = await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        addBook(jane.books, { ...sharedBook, title: `Jane ${index}` }),
      ),
    );
    const omarsBooks = await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        addBook(omar.books, { ...sharedBook, title: `Omar ${index}` }),
      ),
    );

    const responses = await Promise.all([
      ...janesBooks.flatMap((book) => [
        omar.books.update(book.id, { title: 'Hijacked' }),
        omar.books.remove(book.id),
        jane.books.update(book.id, { edition: 'Jane edit' }),
      ]),
      ...omarsBooks.map((book) => omar.books.update(book.id, { edition: 'Omar edit' })),
    ]);

    const omarOnJanesBooks = responses.slice(0, 15).filter((_, index) => index % 3 !== 2);
    expect(omarOnJanesBooks.every((res) => res.status === 404)).toBe(true);
    expect(responses.every((res) => res.status !== 500)).toBe(true);
    const janesStored = await BookModel.find({ ownerId: jane.userId }).lean();
    expect(janesStored.map((book) => book.title).sort()).toEqual(
      janesBooks.map((book) => book.title).sort(),
    );
    expect(janesStored.every((book) => book.deletedAt === null)).toBe(true);
    expect(janesStored.every((book) => book.edition === 'Jane edit')).toBe(true);
    expect(await BookModel.countDocuments({ ownerId: omar.userId, edition: 'Omar edit' })).toBe(5);
  });
});

describe('book endpoints authentication', () => {
  it.each([
    ['an invalid token', () => 'Bearer aaa.bbb.ccc'],
    ['no token', () => undefined],
  ])('rejects every endpoint with %s', async (_label, authorization) => {
    const app = createAuthTestApp();
    const { books } = await signInNewReader(app);
    const book = await addBook(books, sharedBook);
    const header = authorization();
    const withHeader = (test: request.Test) =>
      header === undefined ? test : test.set('Authorization', header);

    const responses = await Promise.all([
      withHeader(request(app).post('/api/v1/books')).send(sharedBook),
      withHeader(request(app).get('/api/v1/books')),
      withHeader(request(app).get('/api/v1/books/duplicate-check?title=Shared')),
      withHeader(request(app).get(`/api/v1/books/${book.id}`)),
      withHeader(request(app).patch(`/api/v1/books/${book.id}`)).send({ title: 'x' }),
      withHeader(request(app).delete(`/api/v1/books/${book.id}`)),
    ]);

    for (const res of responses) {
      expect(res.status).toBe(401);
      expect(res.headers['www-authenticate']).toBe('Bearer');
      expect(res.body.error.code).toBe('UNAUTHENTICATED');
    }
    expect(await BookModel.countDocuments()).toBe(1);
  });

  it('rejects a revoked session immediately', async () => {
    const app = createAuthTestApp();
    const { books, tokens } = await signInNewReader(app);
    const book = await addBook(books, sharedBook);
    await SessionModel.updateMany(
      {},
      { $set: { revokedAt: new Date(), revocationReason: 'logout' } },
    );

    const res = await request(app)
      .get(`/api/v1/books/${book.id}`)
      .set('Authorization', bearer(tokens.accessToken));

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });
});
