import type { Express } from 'express';
import request, { type Test } from 'supertest';
import { expect } from 'vitest';
import type { PaginationMeta } from '../../src/shared/api-response.js';
import type { BookDto } from '../../src/modules/books/book.dto.js';
import type { PhysicalCopyDto } from '../../src/modules/copies/copy.dto.js';
import type { StorageLocationDto } from '../../src/modules/locations/location.dto.js';
import type {
  BookReadingOverviewDto,
  ReadingSessionDto,
} from '../../src/modules/reading/reading.dto.js';
import { bearer, registerReader } from './auth-fixtures.js';
import { booksApiFor } from './book-fixtures.js';

export const UNUSED_ID = '64b7f0c2a1b2c3d4e5f60718';
export const LOCATION_DTO_KEYS = ['id', 'name', 'description', 'createdAt', 'updatedAt'];
export const COPY_DTO_KEYS = [
  'id',
  'bookId',
  'locationId',
  'label',
  'condition',
  'storageNote',
  'createdAt',
  'updatedAt',
];

function authorizedWith(accessToken: string) {
  return (test: Test) => test.set('Authorization', bearer(accessToken));
}

export function locationsApiFor(app: Express, accessToken: string) {
  const authorized = authorizedWith(accessToken);
  return {
    create: (location: object) => authorized(request(app).post('/api/v1/locations')).send(location),
    list: (query: Record<string, string> | string = {}) =>
      authorized(request(app).get('/api/v1/locations')).query(query),
    get: (locationId: string) => authorized(request(app).get(`/api/v1/locations/${locationId}`)),
    update: (locationId: string, changes: object) =>
      authorized(request(app).patch(`/api/v1/locations/${locationId}`)).send(changes),
  };
}

export function copiesApiFor(app: Express, accessToken: string) {
  const authorized = authorizedWith(accessToken);
  return {
    create: (bookId: string, copy: object = {}) =>
      authorized(request(app).post(`/api/v1/books/${bookId}/copies`)).send(copy),
    listForBook: (bookId: string, query: Record<string, string> | string = {}) =>
      authorized(request(app).get(`/api/v1/books/${bookId}/copies`)).query(query),
    get: (copyId: string) => authorized(request(app).get(`/api/v1/copies/${copyId}`)),
    update: (copyId: string, changes: object) =>
      authorized(request(app).patch(`/api/v1/copies/${copyId}`)).send(changes),
    remove: (copyId: string) => authorized(request(app).delete(`/api/v1/copies/${copyId}`)),
  };
}

export function readingApiFor(app: Express, accessToken: string) {
  const authorized = authorizedWith(accessToken);
  return {
    start: (bookId: string, session: object = {}) =>
      authorized(request(app).post(`/api/v1/books/${bookId}/reading-sessions`)).send(session),
    listForBook: (bookId: string, query: Record<string, string> | string = {}) =>
      authorized(request(app).get(`/api/v1/books/${bookId}/reading-sessions`)).query(query),
    overview: (bookId: string) =>
      authorized(request(app).get(`/api/v1/books/${bookId}/reading-overview`)),
    listAll: (query: Record<string, string> | string = {}) =>
      authorized(request(app).get('/api/v1/reading-sessions')).query(query),
    get: (sessionId: string) =>
      authorized(request(app).get(`/api/v1/reading-sessions/${sessionId}`)),
    update: (sessionId: string, changes: object) =>
      authorized(request(app).patch(`/api/v1/reading-sessions/${sessionId}`)).send(changes),
  };
}

export async function signInLibraryReader(app: Express) {
  const { user, tokens } = await registerReader(app);
  return {
    userId: user.id,
    tokens,
    books: booksApiFor(app, tokens.accessToken),
    locations: locationsApiFor(app, tokens.accessToken),
    copies: copiesApiFor(app, tokens.accessToken),
    reading: readingApiFor(app, tokens.accessToken),
  };
}

export type LibraryReader = Awaited<ReturnType<typeof signInLibraryReader>>;

function dataFrom<Resource>(res: { body: unknown }): Resource {
  return (res.body as { data: Resource }).data;
}

export const locationFrom = (res: { body: unknown }) => dataFrom<StorageLocationDto>(res);
export const locationsFrom = (res: { body: unknown }) => dataFrom<StorageLocationDto[]>(res);
export const copyFrom = (res: { body: unknown }) => dataFrom<PhysicalCopyDto>(res);
export const copiesFrom = (res: { body: unknown }) => dataFrom<PhysicalCopyDto[]>(res);

export const sessionFrom = (res: { body: unknown }) => dataFrom<ReadingSessionDto>(res);
export const sessionsFrom = (res: { body: unknown }) => dataFrom<ReadingSessionDto[]>(res);
export const overviewFrom = (res: { body: unknown }) => dataFrom<BookReadingOverviewDto>(res);

export function paginationOf(res: { body: unknown }): PaginationMeta {
  return (res.body as { meta: { pagination: PaginationMeta } }).meta.pagination;
}

async function expectCreated<Resource>(pending: Test): Promise<Resource> {
  const res = await pending;
  expect(res.status).toBe(201);
  return dataFrom<Resource>(res);
}

export function addPhysicalBook(reader: LibraryReader, title = 'The Hobbit') {
  return expectCreated<BookDto>(reader.books.create({ title, format: 'physical' }));
}

export function addEbook(reader: LibraryReader, title = 'The Hobbit (ebook)') {
  return expectCreated<BookDto>(reader.books.create({ title, format: 'ebook' }));
}

export function addLocation(reader: LibraryReader, name: string, description?: string) {
  return expectCreated<StorageLocationDto>(
    reader.locations.create({ name, ...(description !== undefined && { description }) }),
  );
}

export function addCopy(reader: LibraryReader, bookId: string, copy: object = {}) {
  return expectCreated<PhysicalCopyDto>(reader.copies.create(bookId, copy));
}

export function expectNotFound(
  res: { status: number; body: unknown; headers: object },
  message: string,
) {
  expect(res.status).toBe(404);
  expect(res.body).toEqual({
    error: {
      code: 'NOT_FOUND',
      message,
      requestId: (res.headers as Record<string, string>)['x-request-id'],
    },
  });
}

export function startSession(reader: LibraryReader, bookId: string, session: object = {}) {
  return expectCreated<ReadingSessionDto>(reader.reading.start(bookId, session));
}

export async function addBookWithLengths(
  reader: LibraryReader,
  lengths: { pageCount?: number; chapterCount?: number },
  format: 'physical' | 'ebook' = 'physical',
) {
  return expectCreated<BookDto>(
    reader.books.create({ title: 'Measured Book', format, ...lengths }),
  );
}
