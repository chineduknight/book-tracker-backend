import type { Express } from 'express';
import request, { type Test } from 'supertest';
import { expect } from 'vitest';
import type { PaginationMeta } from '../../src/shared/api-response.js';
import type { BookDto } from '../../src/modules/books/book.dto.js';
import { bearer, registerReader } from './auth-fixtures.js';

export const BOOK_DTO_KEYS = [
  'id',
  'title',
  'authors',
  'format',
  'isbn',
  'edition',
  'description',
  'coverUrl',
  'pageCount',
  'chapterCount',
  'publicationYear',
  'createdAt',
  'updatedAt',
];

export const UNUSED_BOOK_ID = '64b7f0c2a1b2c3d4e5f60718';

export type BooksApi = ReturnType<typeof booksApiFor>;

export function booksApiFor(app: Express, accessToken: string) {
  const authorized = (test: Test) => test.set('Authorization', bearer(accessToken));
  return {
    create: (book: object) => authorized(request(app).post('/api/v1/books')).send(book),
    list: (query: Record<string, string> | string = {}) =>
      authorized(request(app).get('/api/v1/books')).query(query),
    duplicateCheck: (query: Record<string, string> | string) =>
      authorized(request(app).get('/api/v1/books/duplicate-check')).query(query),
    get: (bookId: string) => authorized(request(app).get(`/api/v1/books/${bookId}`)),
    update: (bookId: string, changes: object) =>
      authorized(request(app).patch(`/api/v1/books/${bookId}`)).send(changes),
    remove: (bookId: string) => authorized(request(app).delete(`/api/v1/books/${bookId}`)),
  };
}

export async function signInNewReader(app: Express) {
  const { user, tokens } = await registerReader(app);
  return { userId: user.id, tokens, books: booksApiFor(app, tokens.accessToken) };
}

export async function addBook(books: BooksApi, book: object): Promise<BookDto> {
  const res = await books.create(book);
  expect(res.status).toBe(201);
  return bookFrom(res);
}

export function bookFrom(res: { body: unknown }): BookDto {
  return (res.body as { data: BookDto }).data;
}

export function booksFrom(res: { body: unknown }): BookDto[] {
  return (res.body as { data: BookDto[] }).data;
}

export function paginationFrom(res: { body: unknown }): PaginationMeta {
  return (res.body as { meta: { pagination: PaginationMeta } }).meta.pagination;
}

export function titlesFrom(res: { body: unknown }): string[] {
  return booksFrom(res).map((book) => book.title);
}
