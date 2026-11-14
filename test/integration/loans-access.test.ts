import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createLogger } from '../../src/config/logger.js';
import { SessionModel } from '../../src/modules/auth/session.model.js';
import { BookModel } from '../../src/modules/books/book.model.js';
import { PhysicalCopyModel } from '../../src/modules/copies/copy.model.js';
import { LoanModel } from '../../src/modules/loans/loan.model.js';
import { createLogCapture } from '../helpers.js';
import { bearer, createAuthTestApp } from './auth-fixtures.js';
import {
  expectNotFound,
  lendCopy,
  LOAN_DEFAULTS,
  loansFrom,
  signInLender,
  type LibraryReader,
} from './library-fixtures.js';

function loanRequests(app: Parameters<typeof request>[0], copyId: string, loanId: string) {
  return [
    () => request(app).post(`/api/v1/copies/${copyId}/loans`).send(LOAN_DEFAULTS),
    () => request(app).get(`/api/v1/copies/${copyId}/loans`),
    () => request(app).get(`/api/v1/copies/${copyId}/loan-overview`),
    () => request(app).get('/api/v1/loans'),
    () => request(app).get(`/api/v1/loans/${loanId}`),
    () => request(app).patch(`/api/v1/loans/${loanId}`).send({ note: 'x' }),
    () => request(app).put(`/api/v1/loans/${loanId}/return`).send({ returnedOn: '2026-11-20' }),
  ];
}

async function expectLoanInvisibleTo(reader: LibraryReader, loanId: string) {
  expectNotFound(await reader.loans.get(loanId), 'Loan not found');
  expectNotFound(await reader.loans.update(loanId, { borrowerName: 'Hijacked' }), 'Loan not found');
  expectNotFound(await reader.loans.return(loanId, { returnedOn: '2026-11-20' }), 'Loan not found');
  for (const query of [{}, { status: 'all' }, { status: 'overdue', asOf: '2999-01-01' }]) {
    expect(loansFrom(await reader.loans.listAll(query)).map((loan) => loan.id)).not.toContain(
      loanId,
    );
  }
}

describe('loan endpoint authentication', () => {
  it.each([
    ['no token', undefined],
    ['an invalid token', 'Bearer aaa.bbb.ccc'],
  ])('rejects all seven endpoints with %s', async (_label, authorization) => {
    const app = createAuthTestApp();
    const { reader, copy } = await signInLender(app);
    const loan = await lendCopy(reader, copy.id);

    const requests = loanRequests(app, copy.id, loan.id);
    expect(requests).toHaveLength(7);
    for (const send of requests) {
      const pending = send();
      const res = await (authorization === undefined
        ? pending
        : pending.set('Authorization', authorization));
      expect(res.status).toBe(401);
      expect(res.headers['www-authenticate']).toBe('Bearer');
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body.error.code).toBe('UNAUTHENTICATED');
    }
    expect((await LoanModel.findById(loan.id).orFail().lean()).returnedOn).toBeNull();
  });

  it('rejects all seven endpoints once the session is revoked', async () => {
    const app = createAuthTestApp();
    const { reader, copy } = await signInLender(app);
    const loan = await lendCopy(reader, copy.id);
    await SessionModel.updateMany(
      {},
      { $set: { revokedAt: new Date(), revocationReason: 'logout' } },
    );

    for (const send of loanRequests(app, copy.id, loan.id)) {
      const res = await send().set('Authorization', bearer(reader.tokens.accessToken));
      expect(res.status).toBe(401);
      expect(res.headers['cache-control']).toBe('no-store');
    }
  });
});

describe('loan ownership', () => {
  it('keeps two readers’ loans with identical borrowers apart', async () => {
    const app = createAuthTestApp();
    const jane = await signInLender(app);
    const omar = await signInLender(app);
    const janes = await lendCopy(jane.reader, jane.copy.id);
    const omars = await lendCopy(omar.reader, omar.copy.id);

    await expectLoanInvisibleTo(jane.reader, omars.id);
    expectNotFound(await jane.reader.loans.create(omar.copy.id, LOAN_DEFAULTS), 'Copy not found');
    expectNotFound(await jane.reader.loans.listForCopy(omar.copy.id), 'Copy not found');
    expectNotFound(await jane.reader.loans.overview(omar.copy.id), 'Copy not found');
    expect(loansFrom(await jane.reader.loans.listAll()).map((loan) => loan.id)).toEqual([janes.id]);
    expect((await omar.reader.loans.get(omars.id)).body.data).toEqual(omars);
    expect((await LoanModel.findById(omars.id).orFail().lean()).borrowerName).toBe('Ada Okafor');
  });

  it('hides a planted loan whose owner differs from the reader even on the reader’s own copy', async () => {
    const app = createAuthTestApp();
    const { reader, book, copy } = await signInLender(app);
    const other = await signInLender(app);
    const planted = await LoanModel.create({
      ownerId: other.reader.userId,
      copyId: copy.id,
      bookId: book.id,
      borrowerName: 'Planted',
      lentOn: '2026-11-14',
    });
    const plantedId = planted._id.toHexString();

    await expectLoanInvisibleTo(reader, plantedId);
    expect((await reader.loans.overview(copy.id)).body.data).toEqual({
      copyId: copy.id,
      isOnLoan: false,
      activeLoan: null,
    });
    expect((await reader.loans.listForCopy(copy.id)).body.data).toEqual([]);
    expect(await LoanModel.findById(planted._id).orFail().lean()).toMatchObject({
      returnedOn: null,
      borrowerName: 'Planted',
    });
  });

  it('never stores lending state on copies or books', async () => {
    const { reader, book, copy } = await signInLender(createAuthTestApp());
    const copyBefore = await PhysicalCopyModel.findById(copy.id).orFail().lean();
    const bookBefore = await BookModel.findById(book.id).orFail().lean();

    const loan = await lendCopy(reader, copy.id);
    await reader.loans.return(loan.id, { returnedOn: '2026-11-20' });

    expect(await PhysicalCopyModel.findById(copy.id).orFail().lean()).toEqual(copyBefore);
    expect(await BookModel.findById(book.id).orFail().lean()).toEqual(bookBefore);
  });
});

describe('loan logging', () => {
  it('never writes borrower details, dates, notes or query strings to the logs', async () => {
    const logs = createLogCapture();
    const { reader, copy } = await signInLender(
      createAuthTestApp({ logger: createLogger('trace', logs.stream) }),
    );
    const loan = await lendCopy(reader, copy.id, {
      borrowerName: 'Secret Borrower Name',
      borrowerContact: 'secret@example.test',
      lentOn: '1987-03-14',
      dueOn: '1987-04-15',
      note: 'Private lending note',
    });
    await reader.loans.update(loan.id, { note: 'Edited private note' });
    await reader.loans.create(copy.id, { borrowerName: 'Second Secret', lentOn: '1987-05-01' });
    await reader.loans.listAll({ status: 'overdue', asOf: '1999-12-31', sort: 'oldest' });
    await reader.loans.return(loan.id, { returnedOn: '1987-06-01' });
    await reader.loans.return(loan.id, { returnedOn: '1980-01-01' });

    const output = logs.output();
    expect(output).toContain('"path":"/api/v1/loans"');
    expect(output).toContain(`"path":"/api/v1/loans/${loan.id}/return"`);
    for (const privateText of [
      'Secret Borrower',
      'secret@example.test',
      'Second Secret',
      'Private lending',
      'Edited private',
      '1987-03-14',
      '1987-04-15',
      '1987-06-01',
      '1980-01-01',
      'asOf=',
      'status=',
      '"borrowerName"',
      '"returnedOn"',
      reader.tokens.accessToken,
    ]) {
      expect(output).not.toContain(privateText);
    }
  });
});
