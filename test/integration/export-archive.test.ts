import { afterEach, describe, expect, it, vi } from 'vitest';
import { BookModel } from '../../src/modules/books/book.model.js';
import { createAuthTestApp } from './auth-fixtures.js';
import { addRichLibrary, archiveFrom, currentDtosOf, profileOf } from './export-fixtures.js';
import { addPhysicalBook, signInLibraryReader } from './library-fixtures.js';

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const EMPTY_SECTIONS = {
  books: [],
  locations: [],
  copies: [],
  readingSessions: [],
  notes: [],
  categories: [],
  collections: [],
  wishlist: [],
  loans: [],
};

function withoutDeletion<Dto extends object>(dto: Dto) {
  return { ...dto, deletedAt: null };
}

describe('GET /api/v1/export/archive', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('exports a new reader as the profile and every section empty, as a JSON download', async () => {
    const app = createAuthTestApp();
    const reader = await signInLibraryReader(app);

    const res = await reader.exports.archive();

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(res.headers['content-disposition']).toMatch(
      /^attachment; filename="book-tracker-export-\d{4}-\d{2}-\d{2}\.json"$/,
    );
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-request-id']).toEqual(expect.any(String));
    expect(Number(res.headers['content-length'])).toBe(Buffer.byteLength(res.text, 'utf8'));
    expect(res.body).toEqual({
      data: {
        schemaVersion: 1,
        exportedAt: expect.stringMatching(ISO_TIMESTAMP),
        profile: await profileOf(app, reader),
        ...EMPTY_SECTIONS,
      },
    });
    expect(Object.keys(archiveFrom(res))).toEqual([
      'schemaVersion',
      'exportedAt',
      'profile',
      ...Object.keys(EMPTY_SECTIONS),
    ]);
  });

  it('exports every record exactly as the API shows it, plus deletedAt, oldest first', async () => {
    const app = createAuthTestApp();
    const reader = await signInLibraryReader(app);
    const library = await addRichLibrary(reader);
    const current = await currentDtosOf(reader, library);

    const archive = archiveFrom(await reader.exports.archive());

    expect(archive.profile).toEqual(await profileOf(app, reader));
    expect(archive.books).toEqual(current.books.map(withoutDeletion));
    expect(archive.locations).toEqual(current.locations);
    expect(archive.copies).toEqual(current.copies.map(withoutDeletion));
    expect(archive.readingSessions).toEqual(current.readingSessions);
    expect(archive.notes).toEqual(current.notes.map(withoutDeletion));
    expect(archive.categories).toEqual([
      { ...current.categories[0], bookIds: [library.ebook.id, library.paper.id], deletedAt: null },
    ]);
    expect(archive.collections).toEqual([
      { ...current.collections[0], bookIds: [library.paper.id], deletedAt: null },
    ]);
    expect(archive.wishlist).toEqual(current.wishlist.map(withoutDeletion));
    expect(archive.loans).toEqual(current.loans);
    expect(archive.wishlist[1]).toMatchObject({
      status: 'acquired',
      acquiredBookId: library.paper.id,
    });
    expect(archive.notes[0]?.readingSessionId).toBe(library.reread.id);
    expect(archive.copies[0]?.locationId).toBe(library.shelf.id);
    expect(archive.readingSessions.map((session) => session.status)).toEqual([
      'completed',
      'in_progress',
    ]);
    expect(archive.books[0]?.description).toBe('Line one\nLine two — ünïcödé');
  });

  it('keeps soft-deleted records and everything that refers to them', async () => {
    const reader = await signInLibraryReader(createAuthTestApp());
    const library = await addRichLibrary(reader);
    const before = await currentDtosOf(reader, library);
    for (const res of [
      await reader.notes.remove(library.highlight.id),
      await reader.copies.remove(library.paperback.id),
      await reader.wishlist.remove(library.wanted.id),
      await reader.categories.remove(library.category.id),
      await reader.books.remove(library.paper.id),
    ]) {
      expect(res.status).toBe(204);
    }
    expect((await reader.books.get(library.paper.id)).status).toBe(404);
    expect((await reader.notes.listAll()).body.data).toEqual([]);

    const archive = archiveFrom(await reader.exports.archive());

    const deleted = {
      updatedAt: expect.stringMatching(ISO_TIMESTAMP),
      deletedAt: expect.stringMatching(ISO_TIMESTAMP),
    };
    expect(archive.books).toEqual([
      { ...before.books[0], ...deleted },
      withoutDeletion(before.books[1] ?? {}),
    ]);
    expect(archive.copies).toEqual([
      withoutDeletion(before.copies[0] ?? {}),
      { ...before.copies[1], ...deleted },
    ]);
    expect(archive.notes).toEqual([
      withoutDeletion(before.notes[0] ?? {}),
      { ...before.notes[1], ...deleted },
    ]);
    expect(archive.wishlist).toEqual([
      { ...before.wishlist[0], ...deleted },
      withoutDeletion(before.wishlist[1] ?? {}),
    ]);
    expect(archive.categories).toEqual([
      { ...before.categories[0], ...deleted, bookIds: [library.ebook.id, library.paper.id] },
    ]);
    expect(archive.readingSessions).toEqual(before.readingSessions);
    expect(archive.loans).toEqual(before.loans);
    expect(archive.collections[0]?.bookIds).toEqual([library.paper.id]);
  });

  it('produces the same bytes for an unchanged library, apart from exportedAt', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-14T23:55:00.000Z'));
    const reader = await signInLibraryReader(createAuthTestApp());
    await addRichLibrary(reader);

    const first = await reader.exports.archive();
    const second = await reader.exports.archive();
    vi.setSystemTime(new Date('2026-11-15T00:04:00.000Z'));
    const nextDay = await reader.exports.archive();

    expect(second.text).toBe(first.text);
    expect(nextDay.text.replace('2026-11-15T00:04:00.000Z', '2026-11-14T23:55:00.000Z')).toBe(
      first.text,
    );
    expect(nextDay.headers['content-disposition']).toBe(
      'attachment; filename="book-tracker-export-2026-11-15.json"',
    );
  });

  it('orders identical creation times by id and keeps calendar dates and lower-case ids', async () => {
    const reader = await signInLibraryReader(createAuthTestApp());
    const books = [];
    for (const title of ['C', 'A', 'B']) books.push(await addPhysicalBook(reader, title));
    await BookModel.collection.updateMany(
      {},
      { $set: { createdAt: new Date('2026-01-01T00:00:00.000Z') } },
    );
    await addRichLibrary(reader);

    const archive = archiveFrom(await reader.exports.archive());

    expect(archive.books.slice(0, 3).map((book) => book.id)).toEqual(
      books.map((book) => book.id).sort(),
    );
    const hexValues = JSON.stringify(archive).match(/"[0-9a-fA-F]{24}"/g) ?? [];
    expect(hexValues.length).toBeGreaterThan(20);
    for (const value of hexValues) expect(value).toBe(value.toLowerCase());
    expect(archive.readingSessions[0]).toMatchObject({
      startedOn: '2025-12-31',
      completedOn: '2026-01-02',
    });
    expect(archive.loans.map((loan) => [loan.lentOn, loan.dueOn, loan.returnedOn])).toEqual([
      ['2026-01-01', '2026-01-10', null],
      ['2025-12-01', undefined, '2025-12-20'],
    ]);
  });
});
