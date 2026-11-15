import mongoose from 'mongoose';
import { describe, expect, it } from 'vitest';
import { CategoryModel } from '../../src/modules/categories/category.model.js';
import { BookCollectionModel } from '../../src/modules/collections/collection.model.js';
import { PhysicalCopyModel } from '../../src/modules/copies/copy.model.js';
import { LoanModel } from '../../src/modules/loans/loan.model.js';
import { NoteModel } from '../../src/modules/notes/note.model.js';
import { ReadingSessionModel } from '../../src/modules/reading/reading.model.js';
import { WishlistItemModel } from '../../src/modules/wishlist/wishlist.model.js';
import { createAuthTestApp } from './auth-fixtures.js';
import { addRichLibrary, type RichLibrary } from './export-fixtures.js';
import {
  addPhysicalBook,
  signInLibraryReader,
  summaryFrom,
  type LibraryReader,
} from './library-fixtures.js';
import { serializedRecordsOf } from './owner-records.js';

/** Text that exists only in the victim's records; none of it may reach the reader. */
const VICTIM_TEXT = [
  'Café',
  'Society',
  'Ana Ñúñez',
  'Study Shelf',
  'Left wall',
  'Hardback',
  'Loved it',
  'Thoughts',
  'mind-killer',
  'Litany',
  'Philosophy',
  'Favourites',
  'Stoic',
  'Ada Okafor',
  '+234',
  'Bode',
];

const objectId = (id: string) => new mongoose.Types.ObjectId(id);

/*
 * Rows the API would never write: records owned by the reader that point at the victim's book,
 * copy, location and reading session. They model corruption or a future bug, written straight to
 * the collections.
 */
async function plantReferencesToVictim(
  reader: LibraryReader,
  ownBookId: string,
  victim: RichLibrary,
) {
  const ownerId = objectId(reader.userId);
  const now = new Date('2026-11-14T12:00:00.000Z');
  const timestamps = { createdAt: now, updatedAt: now };
  await NoteModel.collection.insertMany([
    {
      ownerId,
      bookId: objectId(victim.paper.id),
      readingSessionId: null,
      kind: 'note',
      content: 'Planted note on a foreign book',
      deletedAt: null,
      ...timestamps,
    },
    {
      ownerId,
      bookId: objectId(ownBookId),
      readingSessionId: objectId(victim.reread.id),
      kind: 'note',
      content: 'Planted note linked to a foreign session',
      deletedAt: null,
      ...timestamps,
    },
  ]);
  await ReadingSessionModel.collection.insertOne({
    ownerId,
    bookId: objectId(victim.paper.id),
    status: 'in_progress',
    progress: null,
    revision: 0,
    ...timestamps,
  });
  await PhysicalCopyModel.collection.insertMany([
    {
      ownerId,
      bookId: objectId(victim.paper.id),
      locationId: objectId(victim.shelf.id),
      deletedAt: null,
      ...timestamps,
    },
    {
      ownerId,
      bookId: objectId(ownBookId),
      locationId: objectId(victim.shelf.id),
      deletedAt: null,
      ...timestamps,
    },
  ]);
  for (const model of [CategoryModel, BookCollectionModel]) {
    await model.collection.insertOne({
      ownerId,
      name: 'Planted group',
      normalizedName: 'planted group',
      bookIds: [objectId(victim.paper.id), objectId(ownBookId)],
      deletedAt: null,
      ...timestamps,
    });
  }
  await WishlistItemModel.collection.insertOne({
    ownerId,
    title: 'Planted wish',
    normalizedTitle: 'planted wish',
    authors: [],
    priority: 'medium',
    priorityRank: 1,
    status: 'acquired',
    acquiredBookId: objectId(victim.paper.id),
    acquiredAt: now,
    deletedAt: null,
    ...timestamps,
  });
  await LoanModel.collection.insertOne({
    ownerId,
    copyId: objectId(victim.hardback.id),
    bookId: objectId(victim.paper.id),
    borrowerName: 'Planted borrower',
    lentOn: '2026-11-01',
    returnedOn: null,
    revision: 0,
    ...timestamps,
  });
}

async function everyViewOf(reader: LibraryReader, ownBookId: string) {
  const [category] = (await reader.categories.list()).body.data as { id: string }[];
  const [collection] = (await reader.collections.list()).body.data as { id: string }[];
  const [loan] = (await reader.loans.listAll()).body.data as { id: string }[];
  const views = [
    reader.books.list(),
    reader.books.list({ q: 'Society' }),
    reader.books.duplicateCheck({ title: 'Café "Society", part 1' }),
    reader.books.get(ownBookId),
    reader.organizationOf(ownBookId),
    reader.copies.listForBook(ownBookId),
    reader.reading.listForBook(ownBookId),
    reader.reading.overview(ownBookId),
    reader.reading.listAll({ status: 'in_progress' }),
    reader.reading.listAll(),
    reader.notes.listForBook(ownBookId),
    reader.notes.listAll(),
    reader.notes.listAll({ q: 'Thoughts' }),
    reader.categories.listBooks(category?.id ?? ''),
    reader.collections.listBooks(collection?.id ?? ''),
    reader.wishlist.list({ status: 'all' }),
    reader.loans.listAll({ status: 'all' }),
    reader.loans.get(loan?.id ?? ''),
    reader.locations.list(),
    reader.dashboard.summary({ asOf: '2026-11-14' }),
    reader.dashboard.readingStatistics(),
    reader.dashboard.recentActivity({ limit: '20' }),
    reader.exports.archive(),
    reader.exports.booksCsv(),
    reader.exports.readingSessionsCsv(),
    reader.exports.loansCsv(),
    reader.exports.notesMarkdown(),
  ];
  return Promise.all(views);
}

describe('planted cross-owner references', () => {
  it('never reveal the referenced owner’s content in any view of the reader', async () => {
    const app = createAuthTestApp();
    const victim = await signInLibraryReader(app);
    const victimLibrary = await addRichLibrary(victim);
    const reader = await signInLibraryReader(app);
    const ownBook = await addPhysicalBook(reader, 'Reader book');
    await plantReferencesToVictim(reader, ownBook.id, victimLibrary);
    const victimBefore = await serializedRecordsOf(victim.userId);

    const responses = await everyViewOf(reader, ownBook.id);

    for (const res of responses) expect(res.status, res.text.slice(0, 200)).toBe(200);
    const everythingTheReaderSaw = responses.map((res) => res.text).join('\n');
    for (const text of VICTIM_TEXT) expect(everythingTheReaderSaw).not.toContain(text);
    expect(await serializedRecordsOf(victim.userId)).toBe(victimBefore);
  });

  it('hides records whose parent belongs to someone else and counts only the reader’s own', async () => {
    const app = createAuthTestApp();
    const victim = await signInLibraryReader(app);
    const victimLibrary = await addRichLibrary(victim);
    const reader = await signInLibraryReader(app);
    const ownBook = await addPhysicalBook(reader, 'Reader book');
    await plantReferencesToVictim(reader, ownBook.id, victimLibrary);

    const notes = (await reader.notes.listAll()).body.data as { content: string }[];
    const ownCopies = (await reader.copies.listForBook(ownBook.id)).body.data as unknown[];
    const categoryBooks = await reader.categories.listBooks(
      ((await reader.categories.list()).body.data as { id: string }[])[0]?.id ?? '',
    );
    const summary = summaryFrom(await reader.dashboard.summary({ asOf: '2026-11-14' }));

    expect(notes.map(({ content }) => content)).toEqual([
      'Planted note linked to a foreign session',
    ]);
    expect(ownCopies).toHaveLength(1);
    expect((categoryBooks.body.data as { id: string }[]).map(({ id }) => id)).toEqual([ownBook.id]);
    expect(summary.catalogue).toEqual({
      totalBooks: 1,
      physicalBooks: 1,
      ebooks: 0,
      physicalCopies: 1,
    });
    expect(summary.reading.totalSessions).toBe(0);
    expect(summary.notes).toEqual({ notes: 1, highlights: 0 });
    for (const foreignView of [
      reader.books.get(victimLibrary.paper.id),
      reader.locations.get(victimLibrary.shelf.id),
      reader.copies.get(victimLibrary.hardback.id),
      reader.reading.get(victimLibrary.reread.id),
      reader.loans.overview(victimLibrary.hardback.id),
    ]) {
      expect((await foreignView).status).toBe(404);
    }
  });
});
