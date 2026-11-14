import mongoose, { type Model } from 'mongoose';
import { describe, expect, it } from 'vitest';
import { BookModel } from '../../src/modules/books/book.model.js';
import type { ActivityDto } from '../../src/modules/dashboard/dashboard.dto.js';
import { LoanModel } from '../../src/modules/loans/loan.model.js';
import { NoteModel } from '../../src/modules/notes/note.model.js';
import { ReadingSessionModel } from '../../src/modules/reading/reading.model.js';
import { WishlistItemModel } from '../../src/modules/wishlist/wishlist.model.js';
import { createAuthTestApp } from './auth-fixtures.js';
import {
  activitiesFrom,
  addCopy,
  addNote,
  addPhysicalBook,
  addWish,
  invalidFieldsOf,
  lendCopy,
  signInLibraryReader,
  startSession,
  type LibraryReader,
} from './library-fixtures.js';

const SOURCE_MODELS = [BookModel, ReadingSessionModel, NoteModel, WishlistItemModel, LoanModel];

function at(minute: number): Date {
  return new Date(Date.UTC(2026, 10, 14, 10, minute));
}

async function setCreatedAt(model: Model<never>, id: string, createdAt: Date) {
  await model.collection.updateOne(
    { _id: new mongoose.Types.ObjectId(id) },
    { $set: { createdAt } },
  );
}

/** One record of every activity type, created one minute apart in this order. */
async function addOneOfEach(reader: LibraryReader) {
  const book = await addPhysicalBook(reader, 'Private Title');
  const session = await startSession(reader, book.id);
  const note = await addNote(reader, book.id, { kind: 'note', content: 'Private thought' });
  const highlight = await addNote(reader, book.id, { kind: 'highlight', content: 'Quoted' });
  const wish = await addWish(reader, { title: 'Wished' });
  const copy = await addCopy(reader, book.id);
  const loan = await lendCopy(reader, copy.id);
  const records = [
    [BookModel, book.id],
    [ReadingSessionModel, session.id],
    [NoteModel, note.id],
    [NoteModel, highlight.id],
    [WishlistItemModel, wish.id],
    [LoanModel, loan.id],
  ] as const;
  for (const [index, [model, id]] of records.entries()) {
    await setCreatedAt(model as unknown as Model<never>, id, at(index));
  }
  return { book, session, note, highlight, wish, copy, loan };
}

function typesOf(activities: ActivityDto[]) {
  return activities.map((activity) => activity.type);
}

describe('GET /api/v1/dashboard/recent-activity', () => {
  it('returns an empty list for a new reader', async () => {
    const reader = await signInLibraryReader(createAuthTestApp());

    const res = await reader.dashboard.recentActivity();

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toEqual({ data: [] });
  });

  it('lists every kind of recorded resource, newest first, with ids and types only', async () => {
    const reader = await signInLibraryReader(createAuthTestApp());
    const { book, session, note, highlight, wish, loan } = await addOneOfEach(reader);

    const res = await reader.dashboard.recentActivity();

    expect(activitiesFrom(res)).toEqual([
      {
        type: 'loan_recorded',
        resourceId: loan.id,
        bookId: book.id,
        occurredAt: at(5).toISOString(),
      },
      {
        type: 'wishlist_item_added',
        resourceId: wish.id,
        bookId: null,
        occurredAt: at(4).toISOString(),
      },
      {
        type: 'highlight_added',
        resourceId: highlight.id,
        bookId: book.id,
        occurredAt: at(3).toISOString(),
      },
      { type: 'note_added', resourceId: note.id, bookId: book.id, occurredAt: at(2).toISOString() },
      {
        type: 'reading_session_recorded',
        resourceId: session.id,
        bookId: book.id,
        occurredAt: at(1).toISOString(),
      },
      { type: 'book_added', resourceId: book.id, bookId: book.id, occurredAt: at(0).toISOString() },
    ]);
    for (const privateText of ['Private Title', 'Private thought', 'Quoted', 'Wished', 'Ada']) {
      expect(res.text).not.toContain(privateText);
    }
    expect(res.body).not.toHaveProperty('meta');
  });

  it('breaks identical timestamps by resource id, descending, across all sources', async () => {
    const reader = await signInLibraryReader(createAuthTestApp());
    await addOneOfEach(reader);
    for (const model of SOURCE_MODELS) {
      await model.collection.updateMany({}, { $set: { createdAt: at(30) } });
    }

    const activities = activitiesFrom(await reader.dashboard.recentActivity({ limit: '20' }));

    const resourceIds = activities.map((activity) => activity.resourceId);
    expect(resourceIds).toEqual([...resourceIds].sort().reverse());
    expect(new Set(activities.map((activity) => activity.occurredAt))).toEqual(
      new Set([at(30).toISOString()]),
    );
    expect(activities).toHaveLength(6);
  });

  it('honours the limit: 10 by default, 1 and 20 on request', async () => {
    const reader = await signInLibraryReader(createAuthTestApp());
    const wishes = [];
    for (let index = 0; index < 25; index += 1)
      wishes.push(await addWish(reader, { title: `W${index}` }));
    for (const [index, wish] of wishes.entries()) {
      await setCreatedAt(WishlistItemModel as unknown as Model<never>, wish.id, at(index));
    }
    const newestFirst = [...wishes].reverse().map((wish) => wish.id);

    const byDefault = activitiesFrom(await reader.dashboard.recentActivity());
    const one = activitiesFrom(await reader.dashboard.recentActivity({ limit: '1' }));
    const twenty = activitiesFrom(await reader.dashboard.recentActivity({ limit: '20' }));

    expect(byDefault.map((activity) => activity.resourceId)).toEqual(newestFirst.slice(0, 10));
    expect(one.map((activity) => activity.resourceId)).toEqual(newestFirst.slice(0, 1));
    expect(twenty.map((activity) => activity.resourceId)).toEqual(newestFirst.slice(0, 20));
  });

  it('filters hidden books before limiting each source, so newer hidden records never crowd out older visible ones', async () => {
    const app = createAuthTestApp();
    const reader = await signInLibraryReader(app);
    const otherReader = await signInLibraryReader(app);
    const visible = await addPhysicalBook(reader, 'Visible');
    const visibleSession = await startSession(reader, visible.id);
    const visibleNote = await addNote(reader, visible.id);
    for (const [model, id] of [
      [BookModel, visible.id],
      [ReadingSessionModel, visibleSession.id],
      [NoteModel, visibleNote.id],
    ] as const) {
      await setCreatedAt(model as unknown as Model<never>, id, at(0));
    }
    const hidden = await addPhysicalBook(reader, 'Hidden');
    for (let index = 0; index < 22; index += 1) {
      await startSession(reader, hidden.id, { status: 'completed' });
      await addNote(reader, hidden.id, { kind: 'highlight', content: `h${index}` });
    }
    await reader.books.remove(hidden.id);
    const foreignBook = await addPhysicalBook(otherReader, 'Foreign');
    await NoteModel.create({
      ownerId: reader.userId,
      bookId: foreignBook.id,
      kind: 'note',
      content: 'planted',
    });
    await ReadingSessionModel.create({
      ownerId: reader.userId,
      bookId: foreignBook.id,
      status: 'completed',
    });

    const activities = activitiesFrom(await reader.dashboard.recentActivity({ limit: '20' }));

    const visibleIdsNewestFirst = [visible.id, visibleSession.id, visibleNote.id].sort().reverse();
    expect(activities.map((activity) => activity.resourceId)).toEqual(visibleIdsNewestFirst);
    expect(new Set(typesOf(activities))).toEqual(
      new Set(['book_added', 'reading_session_recorded', 'note_added']),
    );
    expect(activities.every((activity) => activity.bookId === visible.id)).toBe(true);
  });

  it('keeps loans of deleted copies and books, with their recorded book id', async () => {
    const reader = await signInLibraryReader(createAuthTestApp());
    const book = await addPhysicalBook(reader);
    const copy = await addCopy(reader, book.id);
    const loan = await lendCopy(reader, copy.id);
    await reader.copies.remove(copy.id);
    await reader.books.remove(book.id);

    const activities = activitiesFrom(await reader.dashboard.recentActivity());

    expect(activities).toEqual([
      { type: 'loan_recorded', resourceId: loan.id, bookId: book.id, occurredAt: loan.createdAt },
    ]);
  });

  it('records no events for edits, returns, completions, acquisitions or deletions of other records', async () => {
    const reader = await signInLibraryReader(createAuthTestApp());
    const { book, session, note, wish, loan } = await addOneOfEach(reader);
    const before = activitiesFrom(await reader.dashboard.recentActivity({ limit: '20' }));

    await reader.reading.update(session.id, { status: 'completed' });
    await reader.notes.update(note.id, { content: 'Edited' });
    await reader.books.update(book.id, { title: 'Renamed' });
    await reader.loans.return(loan.id, { returnedOn: '2026-11-20' });
    await reader.wishlist.acquire(wish.id, { bookId: book.id });
    const category = await reader.categories.create({ name: 'Shelf' });
    await reader.categories.addBook((category.body.data as { id: string }).id, book.id);

    expect(activitiesFrom(await reader.dashboard.recentActivity({ limit: '20' }))).toEqual(before);
  });

  it.each([
    ['limit zero', { limit: '0' }],
    ['a limit over 20', { limit: '21' }],
    ['a fractional limit', { limit: '1.5' }],
    ['a repeated limit', 'limit=1&limit=2'],
  ])('rejects %s with 400 naming limit', async (_label, query) => {
    const reader = await signInLibraryReader(createAuthTestApp());

    expect(invalidFieldsOf(await reader.dashboard.recentActivity(query))).toEqual(['limit']);
  });

  it('rejects unknown parameters such as paging', async () => {
    const reader = await signInLibraryReader(createAuthTestApp());

    expect(invalidFieldsOf(await reader.dashboard.recentActivity({ page: '2' }))).toEqual(['page']);
  });
});
