import { afterEach, describe, expect, it, vi } from 'vitest';
import { LoanModel } from '../../src/modules/loans/loan.model.js';
import { createAuthTestApp } from './auth-fixtures.js';
import {
  addCopy,
  expectNotFound,
  invalidFieldsOf,
  lendCopy,
  loanOverviewFrom,
  loansFrom,
  paginationOf,
  signInLender,
  UNUSED_ID,
  type LibraryReader,
} from './library-fixtures.js';

const SAME_INSTANT = new Date('2026-01-01T00:00:00.000Z');

function idsOf(res: { body: unknown }) {
  return loansFrom(res).map((loan) => loan.id);
}

/** Returned, overdue (due 2026-11-10), due today (2026-11-14), undated, future-due loans. */
async function seedLendingHistory(reader: LibraryReader, bookId: string) {
  const copies = await Promise.all(
    ['a', 'b', 'c', 'd', 'e'].map((label) => addCopy(reader, bookId, { label })),
  );
  const returned = await lendCopy(reader, copies[0]!.id, {
    borrowerName: 'Returned',
    lentOn: '2026-10-01',
    dueOn: '2026-10-05',
  });
  await reader.loans.return(returned.id, { returnedOn: '2026-10-20' });
  const overdue = await lendCopy(reader, copies[1]!.id, {
    borrowerName: 'Overdue',
    lentOn: '2026-11-01',
    dueOn: '2026-11-10',
  });
  const dueToday = await lendCopy(reader, copies[2]!.id, {
    borrowerName: 'Due today',
    lentOn: '2026-11-01',
    dueOn: '2026-11-14',
  });
  const undated = await lendCopy(reader, copies[3]!.id, {
    borrowerName: 'Undated',
    lentOn: '2026-11-01',
  });
  const future = await lendCopy(reader, copies[4]!.id, {
    borrowerName: 'Future',
    lentOn: '2026-11-01',
    dueOn: '2027-01-01',
  });
  return { copies, returned, overdue, dueToday, undated, future };
}

describe('GET /api/v1/loans', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('lists active loans by default, newest first, with exact totals', async () => {
    const { reader, book } = await signInLender(createAuthTestApp());
    const { overdue, dueToday, undated, future } = await seedLendingHistory(reader, book.id);

    const res = await reader.loans.listAll();

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(idsOf(res)).toEqual([future.id, undated.id, dueToday.id, overdue.id]);
    expect(paginationOf(res)).toEqual({ page: 1, limit: 20, total: 4, totalPages: 1 });
  });

  it.each([
    ['returned', ['Returned']],
    ['all', ['Future', 'Undated', 'Due today', 'Overdue', 'Returned']],
    ['overdue', ['Overdue']],
  ])('filters status=%s', async (status, borrowers) => {
    const { reader, book } = await signInLender(createAuthTestApp());
    await seedLendingHistory(reader, book.id);

    const res = await reader.loans.listAll(
      { status, asOf: status === 'overdue' ? '2026-11-14' : undefined }.asOf
        ? { status, asOf: '2026-11-14' }
        : { status },
    );

    expect(loansFrom(res).map((loan) => loan.borrowerName)).toEqual(borrowers);
    expect(paginationOf(res).total).toBe(borrowers.length);
  });

  it('treats a loan due on the reference day as not yet overdue and ignores returned loans', async () => {
    const { reader, book } = await signInLender(createAuthTestApp());
    const { overdue, dueToday } = await seedLendingHistory(reader, book.id);

    expect(idsOf(await reader.loans.listAll({ status: 'overdue', asOf: '2026-11-14' }))).toEqual([
      overdue.id,
    ]);
    expect(idsOf(await reader.loans.listAll({ status: 'overdue', asOf: '2026-11-15' }))).toEqual([
      dueToday.id,
      overdue.id,
    ]);
    expect(idsOf(await reader.loans.listAll({ status: 'overdue', asOf: '2026-10-06' }))).toEqual(
      [],
    );
    expect(
      idsOf(await reader.loans.listAll({ status: 'overdue', asOf: '2027-01-02' })),
    ).toHaveLength(3);
  });

  it('defaults the overdue reference day to the current UTC calendar date', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-14T23:55:00.000Z'));
    const { reader, book } = await signInLender(createAuthTestApp());
    const { overdue, dueToday } = await seedLendingHistory(reader, book.id);

    const lateEveningUtc = await reader.loans.listAll({ status: 'overdue' });
    vi.setSystemTime(new Date('2026-11-15T00:04:00.000Z'));
    const nextUtcDay = await reader.loans.listAll({ status: 'overdue' });

    expect(idsOf(lateEveningUtc)).toEqual([overdue.id]);
    expect(idsOf(nextUtcDay)).toEqual([dueToday.id, overdue.id]);
  });

  it('includes loans whose copy or book was deleted, so obligations never vanish', async () => {
    const { reader, copy } = await signInLender(createAuthTestApp());
    const onDeletedCopy = await lendCopy(reader, copy.id);
    const otherBook = await (async () => {
      const created = await reader.books.create({ title: 'Doomed', format: 'physical' });
      return created.body.data as { id: string };
    })();
    const copyOfDeletedBook = await addCopy(reader, otherBook.id);
    const onDeletedBook = await lendCopy(reader, copyOfDeletedBook.id, {
      borrowerName: 'Bode',
      lentOn: '2026-11-14',
    });
    await reader.copies.remove(copy.id);
    await reader.books.remove(otherBook.id);

    const active = await reader.loans.listAll();

    expect(idsOf(active)).toEqual([onDeletedBook.id, onDeletedCopy.id]);
    expect(paginationOf(active).total).toBe(2);
    expectNotFound(await reader.loans.listForCopy(copy.id), 'Copy not found');
    expectNotFound(await reader.loans.listForCopy(copyOfDeletedBook.id), 'Copy not found');
    expectNotFound(await reader.loans.overview(copy.id), 'Copy not found');
  });

  it('breaks ties on identical creation times by id in the sort direction', async () => {
    const { reader, book } = await signInLender(createAuthTestApp());
    const ids = [];
    for (const label of ['1', '2', '3']) {
      const copy = await addCopy(reader, book.id, { label });
      ids.push((await lendCopy(reader, copy.id)).id);
    }
    await LoanModel.updateMany({}, { $set: { createdAt: SAME_INSTANT } });
    const ascending = [...ids].sort();

    expect(idsOf(await reader.loans.listAll())).toEqual([...ascending].reverse());
    expect(idsOf(await reader.loans.listAll({ sort: 'oldest' }))).toEqual(ascending);
  });

  it('pages with exact totals and an empty page past the end', async () => {
    const { reader, book } = await signInLender(createAuthTestApp());
    const { overdue, dueToday, undated, future } = await seedLendingHistory(reader, book.id);

    const pages = await Promise.all(
      ['1', '2', '3'].map((page) => reader.loans.listAll({ limit: '2', page, sort: 'oldest' })),
    );

    expect(pages.map(idsOf)).toEqual([[overdue.id, dueToday.id], [undated.id, future.id], []]);
    expect(paginationOf(pages[2]!)).toEqual({ page: 3, limit: 2, total: 4, totalPages: 2 });
  });

  it.each([
    ['an unknown parameter', { borrower: 'Ada' }, ['borrower']],
    ['a repeated parameter', 'status=all&status=active', ['status']],
    ['an unknown status', { status: 'late' }, ['status']],
    ['an unknown sort', { sort: 'borrower' }, ['sort']],
    ['asOf without overdue', { asOf: '2026-11-14' }, ['asOf']],
    ['asOf with another status', { status: 'all', asOf: '2026-11-14' }, ['asOf']],
    ['an impossible asOf', { status: 'overdue', asOf: '2026-02-30' }, ['asOf']],
    ['page zero', { page: '0' }, ['page']],
    ['a limit over 100', { limit: '101' }, ['limit']],
  ])('rejects %s with 400', async (_label, query, fields) => {
    const { reader } = await signInLender(createAuthTestApp());

    expect(invalidFieldsOf(await reader.loans.listAll(query))).toEqual(fields);
  });
});

describe('GET /api/v1/copies/:copyId/loans', () => {
  it('lists one copy’s history with the same filters and exact totals', async () => {
    const { reader, book, copy } = await signInLender(createAuthTestApp());
    const first = await lendCopy(reader, copy.id, { borrowerName: 'Ada', lentOn: '2026-01-01' });
    await reader.loans.return(first.id, { returnedOn: '2026-02-01' });
    const second = await lendCopy(reader, copy.id, { borrowerName: 'Bode', lentOn: '2026-03-01' });
    const otherCopy = await addCopy(reader, book.id);
    await lendCopy(reader, otherCopy.id);

    expect(idsOf(await reader.loans.listForCopy(copy.id))).toEqual([second.id]);
    expect(idsOf(await reader.loans.listForCopy(copy.id, { status: 'returned' }))).toEqual([
      first.id,
    ]);
    const all = await reader.loans.listForCopy(copy.id, { status: 'all', sort: 'oldest' });
    expect(idsOf(all)).toEqual([first.id, second.id]);
    expect(paginationOf(all)).toEqual({ page: 1, limit: 20, total: 2, totalPages: 1 });
    expect(
      invalidFieldsOf(await reader.loans.listForCopy(copy.id, { asOf: '2026-01-01' })),
    ).toEqual(['asOf']);
  });

  it('responds 404 for missing, foreign and deleted copies', async () => {
    const app = createAuthTestApp();
    const { reader, copy } = await signInLender(app);
    const foreign = await signInLender(app);
    await reader.copies.remove(copy.id);

    for (const copyId of [UNUSED_ID, foreign.copy.id, copy.id]) {
      expectNotFound(await reader.loans.listForCopy(copyId), 'Copy not found');
    }
    expect(invalidFieldsOf(await reader.loans.listForCopy('abc'))).toEqual(['copyId']);
  });
});

describe('GET /api/v1/copies/:copyId/loan-overview', () => {
  it('derives availability from the active loan without storing anything on the copy', async () => {
    const { reader, copy } = await signInLender(createAuthTestApp());
    const copyBefore = (await reader.copies.get(copy.id)).body.data;

    const idle = await reader.loans.overview(copy.id);
    const loan = await lendCopy(reader, copy.id);
    const lent = await reader.loans.overview(copy.id);
    await reader.loans.return(loan.id, { returnedOn: '2026-11-20' });
    const returned = await reader.loans.overview(copy.id);

    expect(idle.status).toBe(200);
    expect(loanOverviewFrom(idle)).toEqual({ copyId: copy.id, isOnLoan: false, activeLoan: null });
    expect(loanOverviewFrom(lent)).toEqual({ copyId: copy.id, isOnLoan: true, activeLoan: loan });
    expect(loanOverviewFrom(returned)).toEqual({
      copyId: copy.id,
      isOnLoan: false,
      activeLoan: null,
    });
    expect((await reader.copies.get(copy.id)).body.data).toEqual(copyBefore);
    expect(invalidFieldsOf(await reader.loans.overview('abc'))).toEqual(['copyId']);
  });

  it('responds 404 for missing, foreign and deleted copies', async () => {
    const app = createAuthTestApp();
    const { reader, copy } = await signInLender(app);
    const foreign = await signInLender(app);
    await lendCopy(reader, copy.id);
    await reader.copies.remove(copy.id);

    for (const copyId of [UNUSED_ID, foreign.copy.id, copy.id]) {
      expectNotFound(await reader.loans.overview(copyId), 'Copy not found');
    }
  });
});
