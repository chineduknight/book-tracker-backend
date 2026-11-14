import { describe, expect, it } from 'vitest';
import { LoanModel } from '../../src/modules/loans/loan.model.js';
import { collectKeys, createAuthTestApp } from './auth-fixtures.js';
import {
  addCopy,
  addEbook,
  addPhysicalBook,
  expectNotFound,
  invalidFieldsOf,
  lendCopy,
  LOAN_DEFAULTS,
  loanFrom,
  signInLender,
  signInLibraryReader,
  UNUSED_ID,
} from './library-fixtures.js';

const OBJECT_ID = /^[0-9a-f]{24}$/;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const INTERNAL_KEYS = ['_id', '__v', 'ownerId', 'revision'];

describe('POST /api/v1/copies/:copyId/loans', () => {
  it('creates an active loan and returns exactly the public LoanDto', async () => {
    const { reader, book, copy } = await signInLender(createAuthTestApp());

    const res = await reader.loans.create(copy.id, {
      borrowerName: '  Ada Okafor ',
      borrowerContact: ' +234 800 000 0000 ',
      lentOn: '2026-11-14',
      dueOn: '2026-12-01',
      note: ' Hardback, please return ',
    });

    expect(res.status).toBe(201);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toEqual({
      data: {
        id: expect.stringMatching(OBJECT_ID),
        copyId: copy.id,
        bookId: book.id,
        borrowerName: 'Ada Okafor',
        borrowerContact: '+234 800 000 0000',
        lentOn: '2026-11-14',
        dueOn: '2026-12-01',
        returnedOn: null,
        note: 'Hardback, please return',
        createdAt: expect.stringMatching(ISO_TIMESTAMP),
        updatedAt: expect.stringMatching(ISO_TIMESTAMP),
      },
    });
    expect(res.headers.location).toBe(`/api/v1/loans/${loanFrom(res).id}`);
    const keys = collectKeys(res.body);
    for (const internal of INTERNAL_KEYS) expect(keys.has(internal)).toBe(false);
    expect(await LoanModel.findById(loanFrom(res).id).orFail().lean()).toMatchObject({
      returnedOn: null,
      revision: 0,
    });
  });

  it('accepts a minimal loan with past or future dates and omits unset fields', async () => {
    const { reader, copy } = await signInLender(createAuthTestApp());

    const backdated = await lendCopy(reader, copy.id, {
      borrowerName: 'Bode',
      lentOn: '1999-12-31',
    });
    await reader.loans.return(backdated.id, { returnedOn: '2000-01-01' });
    const future = await lendCopy(reader, copy.id, {
      borrowerName: 'Chi',
      lentOn: '2999-01-01',
      dueOn: '2999-01-01',
    });

    expect(backdated).not.toHaveProperty('borrowerContact');
    expect(backdated).not.toHaveProperty('dueOn');
    expect(backdated).not.toHaveProperty('note');
    expect(future).toMatchObject({ lentOn: '2999-01-01', dueOn: '2999-01-01', returnedOn: null });
  });

  it('lends two copies of the same book to different people at once', async () => {
    const { reader, book, copy } = await signInLender(createAuthTestApp());
    const secondCopy = await addCopy(reader, book.id, { label: 'Second' });

    const first = await lendCopy(reader, copy.id, { borrowerName: 'Ada', lentOn: '2026-11-14' });
    const second = await lendCopy(reader, secondCopy.id, {
      borrowerName: 'Bode',
      lentOn: '2026-11-14',
    });

    expect([first.bookId, second.bookId]).toEqual([book.id, book.id]);
    expect(first.copyId).not.toBe(second.copyId);
  });

  it('refuses a second active loan on the same copy with 409 COPY_ALREADY_ON_LOAN', async () => {
    const { reader, copy } = await signInLender(createAuthTestApp());
    await lendCopy(reader, copy.id);

    const res = await reader.loans.create(copy.id, {
      borrowerName: 'Someone Else',
      lentOn: '2026-11-15',
    });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: {
        code: 'COPY_ALREADY_ON_LOAN',
        message: 'This copy already has an active loan',
        requestId: res.headers['x-request-id'],
      },
    });
    expect(res.text).not.toContain('Someone Else');
    expect(res.text).not.toContain('11000');
    expect(await LoanModel.countDocuments()).toBe(1);
  });

  it('frees the copy for a new loan once the previous one is returned, keeping history', async () => {
    const { reader, copy } = await signInLender(createAuthTestApp());
    const first = await lendCopy(reader, copy.id);
    expect((await reader.loans.return(first.id, { returnedOn: '2026-11-20' })).status).toBe(200);

    const second = await lendCopy(reader, copy.id, { borrowerName: 'Bode', lentOn: '2026-11-21' });

    expect(second.id).not.toBe(first.id);
    expect(await LoanModel.countDocuments({ copyId: copy.id })).toBe(2);
    expect(await LoanModel.countDocuments({ copyId: copy.id, returnedOn: null })).toBe(1);
  });

  it.each([
    ['a missing copy', () => Promise.resolve(UNUSED_ID)],
    [
      'another reader’s copy',
      async (app: Parameters<typeof signInLibraryReader>[0]) => (await signInLender(app)).copy.id,
    ],
    [
      'a deleted copy',
      async (_app: unknown, lender: Awaited<ReturnType<typeof signInLender>>) => {
        const copy = await addCopy(lender.reader, lender.book.id);
        await lender.reader.copies.remove(copy.id);
        return copy.id;
      },
    ],
    [
      'a copy of a deleted book',
      async (_app: unknown, lender: Awaited<ReturnType<typeof signInLender>>) => {
        const book = await addPhysicalBook(lender.reader, 'Doomed');
        const copy = await addCopy(lender.reader, book.id);
        await lender.reader.books.remove(book.id);
        return copy.id;
      },
    ],
  ])('responds 404 "Copy not found" for %s and stores nothing', async (_label, copyIdFor) => {
    const app = createAuthTestApp();
    const lender = await signInLender(app);
    const copyId = await copyIdFor(app, lender);

    expectNotFound(await lender.reader.loans.create(copyId, LOAN_DEFAULTS), 'Copy not found');
    expect(await LoanModel.countDocuments()).toBe(0);
  });

  it('cannot lend an ebook, which has no copies to lend', async () => {
    const reader = await signInLibraryReader(createAuthTestApp());
    const ebook = await addEbook(reader);

    expectNotFound(await reader.loans.create(ebook.id, LOAN_DEFAULTS), 'Copy not found');
    expect(invalidFieldsOf(await reader.loans.create('abc', LOAN_DEFAULTS))).toEqual(['copyId']);
  });

  it.each([
    ['a missing borrower', { lentOn: '2026-11-14' }, ['borrowerName']],
    ['a blank borrower', { borrowerName: '  ', lentOn: '2026-11-14' }, ['borrowerName']],
    [
      'a too long borrower',
      { borrowerName: 'n'.repeat(161), lentOn: '2026-11-14' },
      ['borrowerName'],
    ],
    ['a missing lentOn', { borrowerName: 'Ada' }, ['lentOn']],
    ['an impossible lentOn', { borrowerName: 'Ada', lentOn: '2026-02-30' }, ['lentOn']],
    ['a non-ISO lentOn', { borrowerName: 'Ada', lentOn: '14/11/2026' }, ['lentOn']],
    [
      'a due date before lending',
      { borrowerName: 'Ada', lentOn: '2026-11-14', dueOn: '2026-11-13' },
      ['dueOn'],
    ],
    ['a blank contact', { ...LOAN_DEFAULTS, borrowerContact: '' }, ['borrowerContact']],
    ['a too long note', { ...LOAN_DEFAULTS, note: 'n'.repeat(2_001) }, ['note']],
    ['a client-set return', { ...LOAN_DEFAULTS, returnedOn: null }, ['returnedOn']],
    [
      'identity and owner fields',
      {
        ...LOAN_DEFAULTS,
        copyId: UNUSED_ID,
        bookId: UNUSED_ID,
        ownerId: UNUSED_ID,
        status: 'active',
      },
      ['copyId', 'bookId', 'ownerId', 'status'],
    ],
  ])('rejects %s with 400 and stores nothing', async (_label, body, fields) => {
    const { reader, copy } = await signInLender(createAuthTestApp());

    expect(invalidFieldsOf(await reader.loans.create(copy.id, body))).toEqual(fields);
    expect(await LoanModel.countDocuments()).toBe(0);
  });

  it('never echoes borrower details in validation errors', async () => {
    const { reader, copy } = await signInLender(createAuthTestApp());

    const res = await reader.loans.create(copy.id, {
      borrowerName: 'PRIVATE-BORROWER '.repeat(20),
      borrowerContact: 'PRIVATE-PHONE',
      lentOn: 'PRIVATE-DATE',
    });

    expect(res.status).toBe(400);
    expect(res.text).not.toMatch(/PRIVATE-/);
  });
});
