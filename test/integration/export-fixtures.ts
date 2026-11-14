import type { Express } from 'express';
import request from 'supertest';
import { expect } from 'vitest';
import type { ArchiveDto } from '../../src/modules/export/export.dto.js';
import { bearer } from './auth-fixtures.js';
import { addBook } from './book-fixtures.js';
import {
  addCopy,
  addEbook,
  addLocation,
  addNote,
  addWish,
  lendCopy,
  putBookInGroup,
  addGroup,
  startSession,
  type LibraryReader,
} from './library-fixtures.js';

export function archiveFrom(res: { body: unknown }): ArchiveDto {
  return (res.body as { data: ArchiveDto }).data;
}

export async function profileOf(app: Express, reader: LibraryReader) {
  const res = await request(app)
    .get('/api/v1/auth/me')
    .set('Authorization', bearer(reader.tokens.accessToken));
  expect(res.status).toBe(200);
  return (res.body as { data: { user: ArchiveDto['profile'] } }).data.user;
}

/** Every kind of record, with relationships between them, created in this order. */
export async function addRichLibrary(reader: LibraryReader) {
  const shelf = await addLocation(reader, 'Study Shelf', 'Left wall');
  const attic = await addLocation(reader, 'Attic');
  const paper = await addBook(reader.books, {
    title: 'Café "Society", part 1',
    authors: ['Ana Ñúñez', 'Bo "B" Lee'],
    format: 'physical',
    isbn: '978-0-441-47812-5',
    description: 'Line one\nLine two — ünïcödé',
    pageCount: 310,
    chapterCount: 12,
    publicationYear: 1969,
  });
  const ebook = await addEbook(reader, 'Dune');
  const hardback = await addCopy(reader, paper.id, {
    label: 'Hardback',
    condition: 'good',
    locationId: shelf.id,
  });
  const paperback = await addCopy(reader, paper.id);
  const firstRead = await startSession(reader, paper.id, {
    status: 'completed',
    startedOn: '2025-12-31',
    completedOn: '2026-01-02',
    rating: 5,
    summary: 'Loved it',
  });
  const reread = await startSession(reader, paper.id, { progress: { unit: 'pages', value: 42 } });
  const note = await addNote(reader, paper.id, {
    kind: 'note',
    content: '# Thoughts\n\n- *on* rereading',
    readingSessionId: reread.id,
  });
  const highlight = await addNote(reader, ebook.id, {
    kind: 'highlight',
    content: 'Fear is the mind-killer.',
    commentary: 'Litany',
    chapter: 'Chapter 1',
    pageNumber: 8,
    title: 'Litany',
  });
  const category = await addGroup(reader.categories, 'Philosophy');
  await putBookInGroup(reader.categories, category.id, ebook.id);
  await putBookInGroup(reader.categories, category.id, paper.id);
  const collection = await addGroup(reader.collections, 'Favourites', 'Best ones');
  await putBookInGroup(reader.collections, collection.id, paper.id);
  const wanted = await addWish(reader, { title: 'Letters from a Stoic', priority: 'high' });
  const acquired = await addWish(reader, { title: 'Dune paperback' });
  expect((await reader.wishlist.acquire(acquired.id, { bookId: paper.id })).status).toBe(200);
  const activeLoan = await lendCopy(reader, hardback.id, {
    borrowerName: 'Ada Okafor',
    borrowerContact: '+234 800 000 0000',
    lentOn: '2026-01-01',
    dueOn: '2026-01-10',
  });
  const returnedLoan = await lendCopy(reader, paperback.id, {
    borrowerName: 'Bode',
    lentOn: '2025-12-01',
  });
  expect((await reader.loans.return(returnedLoan.id, { returnedOn: '2025-12-20' })).status).toBe(
    200,
  );
  return {
    shelf,
    attic,
    paper,
    ebook,
    hardback,
    paperback,
    firstRead,
    reread,
    note,
    highlight,
    category,
    collection,
    wanted,
    acquired,
    activeLoan,
    returnedLoan,
  };
}

export type RichLibrary = Awaited<ReturnType<typeof addRichLibrary>>;

/** The public DTOs the normal API currently returns for each record of the library. */
export async function currentDtosOf(reader: LibraryReader, library: RichLibrary) {
  const dataOf = async (pending: PromiseLike<{ status: number; body: unknown }>) => {
    const res = await pending;
    expect(res.status).toBe(200);
    return (res.body as { data: Record<string, unknown> }).data;
  };
  return {
    books: [
      await dataOf(reader.books.get(library.paper.id)),
      await dataOf(reader.books.get(library.ebook.id)),
    ],
    locations: [
      await dataOf(reader.locations.get(library.shelf.id)),
      await dataOf(reader.locations.get(library.attic.id)),
    ],
    copies: [
      await dataOf(reader.copies.get(library.hardback.id)),
      await dataOf(reader.copies.get(library.paperback.id)),
    ],
    readingSessions: [
      await dataOf(reader.reading.get(library.firstRead.id)),
      await dataOf(reader.reading.get(library.reread.id)),
    ],
    notes: [
      await dataOf(reader.notes.get(library.note.id)),
      await dataOf(reader.notes.get(library.highlight.id)),
    ],
    categories: [await dataOf(reader.categories.get(library.category.id))],
    collections: [await dataOf(reader.collections.get(library.collection.id))],
    wishlist: [
      await dataOf(reader.wishlist.get(library.wanted.id)),
      await dataOf(reader.wishlist.get(library.acquired.id)),
    ],
    loans: [
      await dataOf(reader.loans.get(library.activeLoan.id)),
      await dataOf(reader.loans.get(library.returnedLoan.id)),
    ],
  };
}
