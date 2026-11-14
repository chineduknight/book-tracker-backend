import { describe, expect, it } from 'vitest';
import { LoanModel } from '../../src/modules/loans/loan.model.js';
import { createAuthTestApp } from './auth-fixtures.js';
import {
  expectNotFound,
  invalidFieldsOf,
  lendCopy,
  loanFrom,
  signInLender,
  UNUSED_ID,
} from './library-fixtures.js';

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const FULL_LOAN = {
  borrowerName: 'Ada Okafor',
  borrowerContact: '+234 800',
  lentOn: '2026-11-14',
  dueOn: '2026-12-01',
  note: 'Hardback',
};

function storedLoan(id: string) {
  return LoanModel.findById(id).orFail().lean();
}

describe('GET /api/v1/loans/:loanId', () => {
  it('returns the loan, also after its copy and book are deleted', async () => {
    const { reader, book, copy } = await signInLender(createAuthTestApp());
    const loan = await lendCopy(reader, copy.id, FULL_LOAN);

    const res = await reader.loans.get(loan.id);
    await reader.copies.remove(copy.id);
    await reader.books.remove(book.id);
    const afterDeletion = await reader.loans.get(loan.id);

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toEqual({ data: loan });
    expect(afterDeletion.body).toEqual({ data: loan });
    expect(invalidFieldsOf(await reader.loans.get('abc'))).toEqual(['loanId']);
  });

  it('responds identically for missing and foreign loans', async () => {
    const app = createAuthTestApp();
    const { reader } = await signInLender(app);
    const other = await signInLender(app);
    const foreign = await lendCopy(other.reader, other.copy.id);

    for (const loanId of [UNUSED_ID, foreign.id]) {
      expectNotFound(await reader.loans.get(loanId), 'Loan not found');
    }
  });
});

describe('PATCH /api/v1/loans/:loanId', () => {
  it('corrects borrower details and dates, clears optional fields and bumps the revision', async () => {
    const { reader, copy } = await signInLender(createAuthTestApp());
    const loan = await lendCopy(reader, copy.id, FULL_LOAN);

    const res = await reader.loans.update(loan.id, {
      borrowerName: ' Ada O. ',
      borrowerContact: null,
      lentOn: '2026-11-13',
      dueOn: null,
      note: null,
    });

    expect(res.status).toBe(200);
    expect(loanFrom(res)).toEqual({
      id: loan.id,
      copyId: copy.id,
      bookId: loan.bookId,
      borrowerName: 'Ada O.',
      lentOn: '2026-11-13',
      returnedOn: null,
      createdAt: loan.createdAt,
      updatedAt: expect.stringMatching(ISO_TIMESTAMP),
    });
    const stored = await storedLoan(loan.id);
    expect(stored.revision).toBe(1);
    for (const cleared of ['borrowerContact', 'dueOn', 'note'])
      expect(stored).not.toHaveProperty(cleared);
  });

  it('validates chronology on the merged state', async () => {
    const { reader, copy } = await signInLender(createAuthTestApp());
    const loan = await lendCopy(reader, copy.id, FULL_LOAN);

    const lateLending = await reader.loans.update(loan.id, { lentOn: '2026-12-02' });
    const earlyDue = await reader.loans.update(loan.id, { dueOn: '2026-11-13' });
    const bothMoved = await reader.loans.update(loan.id, {
      lentOn: '2026-12-02',
      dueOn: '2026-12-02',
    });

    expect(lateLending.body.error.details).toEqual([
      { field: 'dueOn', message: 'must be on or after lentOn' },
    ]);
    expect(earlyDue.status).toBe(400);
    expect(bothMoved.status).toBe(200);
    expect(loanFrom(bothMoved)).toMatchObject({ lentOn: '2026-12-02', dueOn: '2026-12-02' });
  });

  it('corrects a returned loan, including its return date, without reopening it', async () => {
    const { reader, copy } = await signInLender(createAuthTestApp());
    const loan = await lendCopy(reader, copy.id, FULL_LOAN);
    await reader.loans.return(loan.id, { returnedOn: '2026-11-20' });

    const corrected = await reader.loans.update(loan.id, {
      returnedOn: '2026-11-21',
      note: 'Late',
    });
    const beforeLending = await reader.loans.update(loan.id, { returnedOn: '2026-11-13' });
    const lentAfterReturn = await reader.loans.update(loan.id, { lentOn: '2026-11-22' });

    expect(loanFrom(corrected)).toMatchObject({ returnedOn: '2026-11-21', note: 'Late' });
    expect(beforeLending.body.error.details).toEqual([
      { field: 'returnedOn', message: 'must be on or after lentOn' },
    ]);
    expect(lentAfterReturn.status).toBe(400);
    expect((await storedLoan(loan.id)).returnedOn).toBe('2026-11-21');
    expect(await LoanModel.countDocuments({ copyId: copy.id, returnedOn: null })).toBe(0);
  });

  it('refuses to set a return date on an active loan or to clear one', async () => {
    const { reader, copy } = await signInLender(createAuthTestApp());
    const loan = await lendCopy(reader, copy.id);

    const onActive = await reader.loans.update(loan.id, { returnedOn: '2026-11-20' });
    await reader.loans.return(loan.id, { returnedOn: '2026-11-20' });
    const cleared = await reader.loans.update(loan.id, { returnedOn: null });

    expect(onActive.status).toBe(400);
    expect(onActive.body.error.details).toEqual([
      {
        field: 'returnedOn',
        message: 'can only be corrected on a returned loan; record the return first',
      },
    ]);
    expect(invalidFieldsOf(cleared)).toEqual(['returnedOn']);
    expect((await storedLoan(loan.id)).returnedOn).toBe('2026-11-20');
  });

  it.each([
    ['an empty body', {}, ['body']],
    ['a null borrower', { borrowerName: null }, ['borrowerName']],
    ['a null lentOn', { lentOn: null }, ['lentOn']],
    ['an impossible date', { dueOn: '2026-13-01' }, ['dueOn']],
    [
      'identity fields',
      { copyId: UNUSED_ID, bookId: UNUSED_ID, ownerId: UNUSED_ID },
      ['copyId', 'bookId', 'ownerId'],
    ],
    ['a status field', { status: 'returned', revision: 9 }, ['status', 'revision']],
  ])('rejects %s with 400 and changes nothing', async (_label, changes, fields) => {
    const { reader, copy } = await signInLender(createAuthTestApp());
    const loan = await lendCopy(reader, copy.id, FULL_LOAN);

    expect(invalidFieldsOf(await reader.loans.update(loan.id, changes))).toEqual(fields);
    expect((await reader.loans.get(loan.id)).body.data).toEqual(loan);
  });

  it('responds 404 for missing and foreign loans and changes nothing', async () => {
    const app = createAuthTestApp();
    const { reader } = await signInLender(app);
    const other = await signInLender(app);
    const foreign = await lendCopy(other.reader, other.copy.id);

    for (const loanId of [UNUSED_ID, foreign.id]) {
      expectNotFound(
        await reader.loans.update(loanId, { borrowerName: 'Hijacked' }),
        'Loan not found',
      );
    }
    expect((await storedLoan(foreign.id)).borrowerName).toBe('Ada Okafor');
  });
});

describe('PUT /api/v1/loans/:loanId/return', () => {
  it('records the return once and is idempotent for the same date without writing', async () => {
    const { reader, copy } = await signInLender(createAuthTestApp());
    const loan = await lendCopy(reader, copy.id, FULL_LOAN);

    const first = await reader.loans.return(loan.id, { returnedOn: '2026-12-05' });
    const repeat = await reader.loans.return(loan.id, { returnedOn: '2026-12-05' });

    expect(first.status).toBe(200);
    expect(loanFrom(first)).toEqual({
      ...loan,
      returnedOn: '2026-12-05',
      updatedAt: expect.any(String),
    });
    expect(repeat.status).toBe(200);
    expect(loanFrom(repeat)).toEqual(loanFrom(first));
    expect((await storedLoan(loan.id)).revision).toBe(1);
  });

  it('refuses a different return date with 409 LOAN_ALREADY_RETURNED', async () => {
    const { reader, copy } = await signInLender(createAuthTestApp());
    const loan = await lendCopy(reader, copy.id);
    await reader.loans.return(loan.id, { returnedOn: '2026-12-05' });

    const res = await reader.loans.return(loan.id, { returnedOn: '2026-12-06' });

    expect(res.status).toBe(409);
    expect(res.body.error).toEqual({
      code: 'LOAN_ALREADY_RETURNED',
      message: 'This loan was already returned on a different date; correct the date with PATCH',
      requestId: res.headers['x-request-id'],
    });
    expect((await storedLoan(loan.id)).returnedOn).toBe('2026-12-05');
  });

  it('rejects a return before lending, impossible dates and extra fields', async () => {
    const { reader, copy } = await signInLender(createAuthTestApp());
    const loan = await lendCopy(reader, copy.id, FULL_LOAN);

    const early = await reader.loans.return(loan.id, { returnedOn: '2026-11-13' });

    expect(early.body.error.details).toEqual([
      { field: 'returnedOn', message: 'must be on or after lentOn' },
    ]);
    expect(invalidFieldsOf(await reader.loans.return(loan.id, {}))).toEqual(['returnedOn']);
    expect(invalidFieldsOf(await reader.loans.return(loan.id, { returnedOn: null }))).toEqual([
      'returnedOn',
    ]);
    expect(
      invalidFieldsOf(await reader.loans.return(loan.id, { returnedOn: '2026-02-30' })),
    ).toEqual(['returnedOn']);
    expect(
      invalidFieldsOf(await reader.loans.return(loan.id, { returnedOn: '2026-12-01', note: 'x' })),
    ).toEqual(['note']);
    expect((await storedLoan(loan.id)).returnedOn).toBeNull();
  });

  it('still records the return after the copy and book were deleted', async () => {
    const { reader, book, copy } = await signInLender(createAuthTestApp());
    const loan = await lendCopy(reader, copy.id);
    await reader.copies.remove(copy.id);
    await reader.books.remove(book.id);

    const res = await reader.loans.return(loan.id, { returnedOn: '2026-11-20' });

    expect(res.status).toBe(200);
    expect(loanFrom(res).returnedOn).toBe('2026-11-20');
    expect((await reader.loans.listAll()).body.data).toEqual([]);
    expect((await reader.loans.listAll({ status: 'returned' })).body.data).toEqual([loanFrom(res)]);
  });

  it('responds 404 for missing and foreign loans and never returns them', async () => {
    const app = createAuthTestApp();
    const { reader } = await signInLender(app);
    const other = await signInLender(app);
    const foreign = await lendCopy(other.reader, other.copy.id);

    for (const loanId of [UNUSED_ID, foreign.id]) {
      expectNotFound(
        await reader.loans.return(loanId, { returnedOn: '2026-11-20' }),
        'Loan not found',
      );
    }
    expect((await storedLoan(foreign.id)).returnedOn).toBeNull();
  });
});
