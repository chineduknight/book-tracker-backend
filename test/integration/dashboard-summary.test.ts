import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAuthTestApp } from './auth-fixtures.js';
import {
  addBooksInEveryReadingState,
  EMPTY_SUMMARY,
  expectConsistentSummary,
} from './dashboard-fixtures.js';
import {
  addCopy,
  addEbook,
  addNote,
  addPhysicalBook,
  addWish,
  invalidFieldsOf,
  lendCopy,
  signInLibraryReader,
  summaryFrom,
  type LibraryReader,
} from './library-fixtures.js';

/**
 * Loans as of 2026-11-14: active without due date, overdue, due today, returned, and two
 * overdue loans whose copy or book is deleted afterwards.
 */
async function addLoansInEveryState(reader: LibraryReader) {
  const book = await addPhysicalBook(reader, 'Lent');
  const copies = [];
  for (let index = 0; index < 5; index += 1) copies.push(await addCopy(reader, book.id));
  await lendCopy(reader, copies[0]!.id, { borrowerName: 'A', lentOn: '2026-11-01' });
  await lendCopy(reader, copies[1]!.id, {
    borrowerName: 'B',
    lentOn: '2026-11-01',
    dueOn: '2026-11-10',
  });
  await lendCopy(reader, copies[2]!.id, {
    borrowerName: 'C',
    lentOn: '2026-11-01',
    dueOn: '2026-11-14',
  });
  const returned = await lendCopy(reader, copies[3]!.id, {
    borrowerName: 'D',
    lentOn: '2026-10-01',
    dueOn: '2026-10-05',
  });
  await reader.loans.return(returned.id, { returnedOn: '2026-10-20' });
  await lendCopy(reader, copies[4]!.id, {
    borrowerName: 'E',
    lentOn: '2026-10-01',
    dueOn: '2026-11-01',
  });
  expect((await reader.copies.remove(copies[4]!.id)).status).toBe(204);
  const deletedBook = await addPhysicalBook(reader, 'Deleted');
  const copyOfDeletedBook = await addCopy(reader, deletedBook.id);
  await lendCopy(reader, copyOfDeletedBook.id, {
    borrowerName: 'F',
    lentOn: '2026-11-01',
    dueOn: '2026-11-13',
  });
  expect((await reader.books.remove(deletedBook.id)).status).toBe(204);
}

describe('GET /api/v1/dashboard/summary', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns all zeros and today’s UTC date for a new reader', async () => {
    const reader = await signInLibraryReader(createAuthTestApp());

    const res = await reader.dashboard.summary();

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toEqual({
      data: { asOf: new Date().toISOString().slice(0, 10), ...EMPTY_SUMMARY },
    });
  });

  it('counts books, not copies or wishes, and only copies of visible books', async () => {
    const reader = await signInLibraryReader(createAuthTestApp());
    const physical = await addPhysicalBook(reader, 'Paper');
    const copies = await Promise.all([1, 2, 3].map(() => addCopy(reader, physical.id)));
    await addEbook(reader, 'Digital');
    await addWish(reader, { title: 'Paper' });
    const doomed = await addPhysicalBook(reader, 'Doomed');
    await addCopy(reader, doomed.id);
    await addCopy(reader, doomed.id);

    const before = summaryFrom(await reader.dashboard.summary()).catalogue;
    await reader.copies.remove(copies[0]!.id);
    await reader.books.remove(doomed.id);
    const after = summaryFrom(await reader.dashboard.summary()).catalogue;

    expect(before).toEqual({ totalBooks: 3, physicalBooks: 2, ebooks: 1, physicalCopies: 5 });
    expect(after).toEqual({ totalBooks: 2, physicalBooks: 1, ebooks: 1, physicalCopies: 2 });
  });

  it('counts notes and highlights of visible books only', async () => {
    const reader = await signInLibraryReader(createAuthTestApp());
    const book = await addPhysicalBook(reader);
    const doomed = await addEbook(reader);
    await addNote(reader, book.id, { kind: 'note', content: 'a' });
    const deletedNote = await addNote(reader, book.id, { kind: 'note', content: 'b' });
    await addNote(reader, book.id, { kind: 'highlight', content: 'c' });
    await addNote(reader, doomed.id, { kind: 'highlight', content: 'd' });
    await reader.notes.remove(deletedNote.id);
    await reader.books.remove(doomed.id);

    expect(summaryFrom(await reader.dashboard.summary()).notes).toEqual({
      notes: 1,
      highlights: 1,
    });
  });

  it('counts wanted and acquired wishes, keeping acquisitions whose book was deleted', async () => {
    const reader = await signInLibraryReader(createAuthTestApp());
    const book = await addPhysicalBook(reader);
    await addWish(reader, { title: 'Wanted' });
    const deletedWish = await addWish(reader, { title: 'Dropped' });
    const acquired = await addWish(reader, { title: 'Bought' });
    await reader.wishlist.acquire(acquired.id, { bookId: book.id });
    await reader.wishlist.remove(deletedWish.id);
    await reader.books.remove(book.id);

    const summary = summaryFrom(await reader.dashboard.summary());

    expect(summary.wishlist).toEqual({ wanted: 1, acquired: 1 });
    expect(summary.catalogue.totalBooks).toBe(0);
  });

  it('counts every loan, including those of deleted copies and books, against a strict asOf', async () => {
    const reader = await signInLibraryReader(createAuthTestApp());
    await addLoansInEveryState(reader);

    const onDueDay = summaryFrom(await reader.dashboard.summary({ asOf: '2026-11-14' }));
    const dayAfter = summaryFrom(await reader.dashboard.summary({ asOf: '2026-11-15' }));
    const longBefore = summaryFrom(await reader.dashboard.summary({ asOf: '2026-01-01' }));

    expect(onDueDay.asOf).toBe('2026-11-14');
    expect(onDueDay.lending).toEqual({ activeLoans: 5, overdueLoans: 3, returnedLoans: 1 });
    expect(dayAfter.lending).toEqual({ activeLoans: 5, overdueLoans: 4, returnedLoans: 1 });
    expect(longBefore.lending.overdueLoans).toBe(0);
    expect(onDueDay.catalogue).toEqual({
      totalBooks: 1,
      physicalBooks: 1,
      ebooks: 0,
      physicalCopies: 4,
    });
  });

  it('defaults asOf to the current UTC calendar day', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-14T23:55:00.000Z'));
    const reader = await signInLibraryReader(createAuthTestApp());
    await addLoansInEveryState(reader);

    const lateEvening = summaryFrom(await reader.dashboard.summary());
    vi.setSystemTime(new Date('2026-11-15T00:04:00.000Z'));
    const nextUtcDay = summaryFrom(await reader.dashboard.summary());

    expect(lateEvening.asOf).toBe('2026-11-14');
    expect(lateEvening.lending.overdueLoans).toBe(3);
    expect(nextUtcDay.asOf).toBe('2026-11-15');
    expect(nextUtcDay.lending.overdueLoans).toBe(4);
  });

  it('keeps every invariant on a library with rereads, deletions and loans', async () => {
    const reader = await signInLibraryReader(createAuthTestApp());
    await addBooksInEveryReadingState(reader);
    await addLoansInEveryState(reader);
    await addWish(reader);

    const summary = summaryFrom(await reader.dashboard.summary({ asOf: '2026-11-14' }));

    expectConsistentSummary(summary);
    expect(summary.reading).toEqual({
      unreadBooks: 2,
      currentlyReadingBooks: 2,
      completedBooks: 2,
      booksEverCompleted: 3,
      totalSessions: 7,
      completedSessions: 5,
      rereadSessions: 3,
    });
    expect(summary.catalogue).toEqual({
      totalBooks: 6,
      physicalBooks: 4,
      ebooks: 2,
      physicalCopies: 4,
    });
  });

  it.each([
    ['an impossible asOf', { asOf: '2026-02-30' }, ['asOf']],
    ['a timestamp asOf', { asOf: '2026-11-14T00:00:00Z' }, ['asOf']],
    ['a repeated asOf', 'asOf=2026-11-14&asOf=2026-11-15', ['asOf']],
    ['an unknown parameter', { status: 'overdue' }, ['status']],
  ])('rejects %s with 400', async (_label, query, fields) => {
    const reader = await signInLibraryReader(createAuthTestApp());

    expect(invalidFieldsOf(await reader.dashboard.summary(query))).toEqual(fields);
  });
});
