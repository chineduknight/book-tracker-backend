import type { Express } from 'express';
import request, { type Test } from 'supertest';
import { expect } from 'vitest';
import type { PaginationMeta } from '../../src/shared/api-response.js';
import type { BookDto } from '../../src/modules/books/book.dto.js';
import type { CategoryDto } from '../../src/modules/categories/category.dto.js';
import type { BookCollectionDto } from '../../src/modules/collections/collection.dto.js';
import type { PhysicalCopyDto } from '../../src/modules/copies/copy.dto.js';
import type { CopyLoanOverviewDto, LoanDto } from '../../src/modules/loans/loan.dto.js';
import type { StorageLocationDto } from '../../src/modules/locations/location.dto.js';
import type { NoteDto } from '../../src/modules/notes/note.dto.js';
import type { BookOrganizationDto } from '../../src/modules/organization/organization.dto.js';
import type { WishlistItemDto } from '../../src/modules/wishlist/wishlist.dto.js';
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

export function notesApiFor(app: Express, accessToken: string) {
  const authorized = authorizedWith(accessToken);
  return {
    create: (bookId: string, note: object) =>
      authorized(request(app).post(`/api/v1/books/${bookId}/notes`)).send(note),
    listForBook: (bookId: string, query: Record<string, string> | string = {}) =>
      authorized(request(app).get(`/api/v1/books/${bookId}/notes`)).query(query),
    listAll: (query: Record<string, string> | string = {}) =>
      authorized(request(app).get('/api/v1/notes')).query(query),
    get: (noteId: string) => authorized(request(app).get(`/api/v1/notes/${noteId}`)),
    update: (noteId: string, changes: object) =>
      authorized(request(app).patch(`/api/v1/notes/${noteId}`)).send(changes),
    remove: (noteId: string) => authorized(request(app).delete(`/api/v1/notes/${noteId}`)),
  };
}

/** Categories and collections share one API shape, so tests can run against both. */
export function groupsApiFor(app: Express, accessToken: string, rootPath: string) {
  const authorized = authorizedWith(accessToken);
  const root = `/api/v1/${rootPath}`;
  return {
    rootPath,
    create: (group: object) => authorized(request(app).post(root)).send(group),
    list: (query: Record<string, string> | string = {}) =>
      authorized(request(app).get(root)).query(query),
    get: (groupId: string) => authorized(request(app).get(`${root}/${groupId}`)),
    update: (groupId: string, changes: object) =>
      authorized(request(app).patch(`${root}/${groupId}`)).send(changes),
    remove: (groupId: string) => authorized(request(app).delete(`${root}/${groupId}`)),
    addBook: (groupId: string, bookId: string) =>
      authorized(request(app).put(`${root}/${groupId}/books/${bookId}`)),
    removeBook: (groupId: string, bookId: string) =>
      authorized(request(app).delete(`${root}/${groupId}/books/${bookId}`)),
    listBooks: (groupId: string, query: Record<string, string> | string = {}) =>
      authorized(request(app).get(`${root}/${groupId}/books`)).query(query),
  };
}

export type GroupsApi = ReturnType<typeof groupsApiFor>;

export function loansApiFor(app: Express, accessToken: string) {
  const authorized = authorizedWith(accessToken);
  return {
    create: (copyId: string, loan: object) =>
      authorized(request(app).post(`/api/v1/copies/${copyId}/loans`)).send(loan),
    listForCopy: (copyId: string, query: Record<string, string> | string = {}) =>
      authorized(request(app).get(`/api/v1/copies/${copyId}/loans`)).query(query),
    overview: (copyId: string) =>
      authorized(request(app).get(`/api/v1/copies/${copyId}/loan-overview`)),
    listAll: (query: Record<string, string> | string = {}) =>
      authorized(request(app).get('/api/v1/loans')).query(query),
    get: (loanId: string) => authorized(request(app).get(`/api/v1/loans/${loanId}`)),
    update: (loanId: string, changes: object) =>
      authorized(request(app).patch(`/api/v1/loans/${loanId}`)).send(changes),
    return: (loanId: string, loanReturn: object) =>
      authorized(request(app).put(`/api/v1/loans/${loanId}/return`)).send(loanReturn),
  };
}

export function wishlistApiFor(app: Express, accessToken: string) {
  const authorized = authorizedWith(accessToken);
  return {
    create: (item: object) => authorized(request(app).post('/api/v1/wishlist')).send(item),
    list: (query: Record<string, string> | string = {}) =>
      authorized(request(app).get('/api/v1/wishlist')).query(query),
    get: (itemId: string) => authorized(request(app).get(`/api/v1/wishlist/${itemId}`)),
    update: (itemId: string, changes: object) =>
      authorized(request(app).patch(`/api/v1/wishlist/${itemId}`)).send(changes),
    acquire: (itemId: string, acquisition: object) =>
      authorized(request(app).put(`/api/v1/wishlist/${itemId}/acquisition`)).send(acquisition),
    remove: (itemId: string) => authorized(request(app).delete(`/api/v1/wishlist/${itemId}`)),
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
    notes: notesApiFor(app, tokens.accessToken),
    categories: groupsApiFor(app, tokens.accessToken, 'categories'),
    collections: groupsApiFor(app, tokens.accessToken, 'collections'),
    wishlist: wishlistApiFor(app, tokens.accessToken),
    loans: loansApiFor(app, tokens.accessToken),
    presets: () =>
      authorizedWith(tokens.accessToken)(request(app).get('/api/v1/categories/presets')),
    organizationOf: (bookId: string) =>
      authorizedWith(tokens.accessToken)(request(app).get(`/api/v1/books/${bookId}/organization`)),
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

export const noteFrom = (res: { body: unknown }) => dataFrom<NoteDto>(res);
export const notesFrom = (res: { body: unknown }) => dataFrom<NoteDto[]>(res);

export type GroupDto = CategoryDto | BookCollectionDto;
export const groupFrom = (res: { body: unknown }) => dataFrom<GroupDto>(res);
export const groupsFrom = (res: { body: unknown }) => dataFrom<GroupDto[]>(res);
export const booksFrom = (res: { body: unknown }) => dataFrom<BookDto[]>(res);
export const organizationFrom = (res: { body: unknown }) => dataFrom<BookOrganizationDto>(res);
export const loanFrom = (res: { body: unknown }) => dataFrom<LoanDto>(res);
export const loansFrom = (res: { body: unknown }) => dataFrom<LoanDto[]>(res);
export const loanOverviewFrom = (res: { body: unknown }) => dataFrom<CopyLoanOverviewDto>(res);
export const wishFrom = (res: { body: unknown }) => dataFrom<WishlistItemDto>(res);
export const wishesFrom = (res: { body: unknown }) => dataFrom<WishlistItemDto[]>(res);

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

/** Field names of a 400 VALIDATION_ERROR response's details, in order. */
export function invalidFieldsOf(res: { status: number; body: unknown }): string[] {
  expect(res.status).toBe(400);
  const { error } = res.body as { error: { code: string; details: { field: string }[] } };
  expect(error.code).toBe('VALIDATION_ERROR');
  return error.details.map((detail) => detail.field);
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

export function addNote(
  reader: LibraryReader,
  bookId: string,
  note: object = { kind: 'note', content: 'A thought' },
) {
  return expectCreated<NoteDto>(reader.notes.create(bookId, note));
}

export function addGroup(groups: GroupsApi, name: string, description?: string) {
  return expectCreated<GroupDto>(
    groups.create({ name, ...(description !== undefined && { description }) }),
  );
}

export async function putBookInGroup(groups: GroupsApi, groupId: string, bookId: string) {
  const res = await groups.addBook(groupId, bookId);
  expect(res.status).toBe(204);
}

/** The two group kinds, for tests that must hold for both. */
export const GROUP_KINDS = [
  ['category', 'categories', 'Category not found'],
  ['collection', 'collections', 'Collection not found'],
] as const;
export type GroupKind = (typeof GROUP_KINDS)[number][1];

export function addWish(reader: LibraryReader, item: object = { title: 'Dune' }) {
  return expectCreated<WishlistItemDto>(reader.wishlist.create(item));
}

export const LOAN_DEFAULTS = { borrowerName: 'Ada Okafor', lentOn: '2026-11-14' };

export function lendCopy(reader: LibraryReader, copyId: string, loan: object = LOAN_DEFAULTS) {
  return expectCreated<LoanDto>(reader.loans.create(copyId, loan));
}

/** A reader with one physical book and one of its copies, the usual lending fixture. */
export async function signInLender(app: Express) {
  const reader = await signInLibraryReader(app);
  const book = await addPhysicalBook(reader);
  const copy = await addCopy(reader, book.id);
  return { reader, book, copy };
}
