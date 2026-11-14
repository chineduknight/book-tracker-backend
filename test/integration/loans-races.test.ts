import { afterEach, describe, expect, it, vi } from 'vitest';
import { LoanModel } from '../../src/modules/loans/loan.model.js';
import { createAuthTestApp } from './auth-fixtures.js';
import { addCopy, lendCopy, loanFrom, loansFrom, signInLender } from './library-fixtures.js';

const ROUNDS = 5;
const CONCURRENT_LENDS = 25;

function storedLoan(id: string) {
  return LoanModel.findById(id).orFail().lean();
}

describe('concurrent lending', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('lets the unique index pick exactly one of twenty-five simultaneous lends per round', async () => {
    const { reader, book, copy } = await signInLender(createAuthTestApp());
    const otherCopy = await addCopy(reader, book.id, { label: 'Other' });

    for (let round = 0; round < ROUNDS; round += 1) {
      const responses = await Promise.all(
        Array.from({ length: CONCURRENT_LENDS }, (_, index) =>
          reader.loans.create(copy.id, { borrowerName: `Borrower ${index}`, lentOn: '2026-11-14' }),
        ),
      );

      const created = responses.filter((res) => res.status === 201);
      expect(created).toHaveLength(1);
      expect(responses.filter((res) => res.status === 409)).toHaveLength(CONCURRENT_LENDS - 1);
      for (const res of responses) {
        if (res.status === 409) expect(res.body.error.code).toBe('COPY_ALREADY_ON_LOAN');
      }
      expect(await LoanModel.countDocuments({ copyId: copy.id, returnedOn: null })).toBe(1);
      expect(
        (await reader.loans.return(loanFrom(created[0]!).id, { returnedOn: '2026-11-15' })).status,
      ).toBe(200);
    }
    expect(await LoanModel.countDocuments({ copyId: copy.id })).toBe(ROUNDS);
    expect(
      (
        await reader.loans.create(otherCopy.id, {
          borrowerName: 'Independent',
          lentOn: '2026-11-14',
        })
      ).status,
    ).toBe(201);
  });

  it('resolves concurrent same-date returns idempotently and different dates to one winner', async () => {
    const { reader, copy } = await signInLender(createAuthTestApp());

    for (let round = 0; round < ROUNDS; round += 1) {
      const loan = await lendCopy(reader, copy.id);

      const sameDate = await Promise.all(
        Array.from({ length: 8 }, () => reader.loans.return(loan.id, { returnedOn: '2026-11-20' })),
      );

      expect(sameDate.map((res) => res.status)).toEqual(Array<number>(8).fill(200));
      expect(new Set(sameDate.map((res) => loanFrom(res).updatedAt)).size).toBe(1);
      expect((await storedLoan(loan.id)).revision).toBe(1);

      const nextLoan = await lendCopy(reader, copy.id, {
        borrowerName: 'Bode',
        lentOn: '2026-11-21',
      });
      const differentDates = await Promise.all(
        ['2026-11-22', '2026-11-23', '2026-11-24', '2026-11-25'].map((returnedOn) =>
          reader.loans.return(nextLoan.id, { returnedOn }),
        ),
      );

      const winners = differentDates.filter((res) => res.status === 200);
      expect(winners).toHaveLength(1);
      expect(differentDates.filter((res) => res.status === 409)).toHaveLength(3);
      for (const res of differentDates) {
        if (res.status === 409) expect(res.body.error.code).toBe('LOAN_ALREADY_RETURNED');
      }
      expect((await storedLoan(nextLoan.id)).returnedOn).toBe(loanFrom(winners[0]!).returnedOn);
    }
  });

  it('never stores a return before the lending date when PATCH and return race', async () => {
    const { reader, copy } = await signInLender(createAuthTestApp());

    for (let round = 0; round < ROUNDS; round += 1) {
      const loan = await lendCopy(reader, copy.id, {
        borrowerName: 'Ada',
        lentOn: '2026-11-01',
        dueOn: '2026-11-30',
      });

      const responses = await Promise.all([
        reader.loans.update(loan.id, { lentOn: '2026-11-20' }),
        reader.loans.return(loan.id, { returnedOn: '2026-11-10' }),
        reader.loans.update(loan.id, { dueOn: '2026-11-05' }),
      ]);

      for (const res of responses) expect([200, 400]).toContain(res.status);
      const stored = await storedLoan(loan.id);
      if (stored.dueOn != null) expect(stored.dueOn >= stored.lentOn).toBe(true);
      if (stored.returnedOn != null) expect(stored.returnedOn >= stored.lentOn).toBe(true);
      if (stored.returnedOn == null) {
        expect((await reader.loans.return(loan.id, { returnedOn: '2026-12-31' })).status).toBe(200);
      }
    }
  });

  it('keeps every field when concurrent PATCHes change different fields', async () => {
    const { reader, copy } = await signInLender(createAuthTestApp());
    const loan = await lendCopy(reader, copy.id);

    const responses = await Promise.all([
      reader.loans.update(loan.id, { borrowerName: 'Renamed' }),
      reader.loans.update(loan.id, { borrowerContact: 'contact' }),
      reader.loans.update(loan.id, { note: 'noted' }),
      reader.loans.update(loan.id, { dueOn: '2026-12-31' }),
    ]);

    expect(responses.map((res) => res.status)).toEqual([200, 200, 200, 200]);
    expect((await reader.loans.get(loan.id)).body.data).toMatchObject({
      borrowerName: 'Renamed',
      borrowerContact: 'contact',
      note: 'noted',
      dueOn: '2026-12-31',
    });
    expect((await storedLoan(loan.id)).revision).toBe(4);
  });

  it('gives up with 409 LOAN_UPDATE_CONFLICT after five attempts when the loan keeps changing', async () => {
    const { reader, copy } = await signInLender(createAuthTestApp());
    const loan = await lendCopy(reader, copy.id);
    const alwaysStale = vi
      .spyOn(LoanModel, 'findOneAndUpdate')
      .mockImplementation(
        () =>
          ({ lean: () => Promise.resolve(null) }) as unknown as ReturnType<
            typeof LoanModel.findOneAndUpdate
          >,
      );

    const update = await reader.loans.update(loan.id, { note: 'contended' });
    const loanReturn = await reader.loans.return(loan.id, { returnedOn: '2026-11-20' });

    expect(update.status).toBe(409);
    expect(update.body.error.code).toBe('LOAN_UPDATE_CONFLICT');
    expect(loanReturn.status).toBe(409);
    expect(loanReturn.body.error.code).toBe('LOAN_UPDATE_CONFLICT');
    expect(alwaysStale).toHaveBeenCalledTimes(10);
    alwaysStale.mockRestore();
    expect((await reader.loans.get(loan.id)).body.data).toEqual(loan);
  });
});

describe('lending and deletion races', () => {
  it('keeps a loan created while its copy is deleted visible and returnable', async () => {
    const { reader, book } = await signInLender(createAuthTestApp());

    for (let round = 0; round < ROUNDS; round += 1) {
      const copy = await addCopy(reader, book.id, { label: `Race ${round}` });

      const [creation, removal] = await Promise.all([
        reader.loans.create(copy.id, { borrowerName: 'Ada', lentOn: '2026-11-14' }),
        reader.copies.remove(copy.id),
      ]);

      expect(removal.status).toBe(204);
      expect([201, 404]).toContain(creation.status);
      expect((await reader.copies.get(copy.id)).status).toBe(404);
      if (creation.status === 201) {
        const loan = loanFrom(creation);
        expect(loan.bookId).toBe(book.id);
        expect(loansFrom(await reader.loans.listAll()).map((active) => active.id)).toContain(
          loan.id,
        );
        expect((await reader.loans.return(loan.id, { returnedOn: '2026-11-15' })).status).toBe(200);
      }
    }
  });

  it('records a return racing copy and book deletion without losing the loan', async () => {
    const { reader } = await signInLender(createAuthTestApp());

    for (let round = 0; round < ROUNDS; round += 1) {
      const created = await reader.books.create({ title: `Race ${round}`, format: 'physical' });
      const bookId = (created.body.data as { id: string }).id;
      const copy = await addCopy(reader, bookId);
      const loan = await lendCopy(reader, copy.id);

      const [loanReturn, copyRemoval, bookRemoval] = await Promise.all([
        reader.loans.return(loan.id, { returnedOn: '2026-11-20' }),
        reader.copies.remove(copy.id),
        reader.books.remove(bookId),
      ]);

      expect(loanReturn.status).toBe(200);
      expect([204, 404]).toContain(copyRemoval.status);
      expect(bookRemoval.status).toBe(204);
      expect(await storedLoan(loan.id)).toMatchObject({ returnedOn: '2026-11-20' });
      expect((await reader.loans.get(loan.id)).status).toBe(200);
    }
  });
});
