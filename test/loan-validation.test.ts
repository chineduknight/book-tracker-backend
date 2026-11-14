import { Types } from 'mongoose';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { toPublicLoan } from '../src/modules/loans/loan.dto.js';
import type { LoanRecord } from '../src/modules/loans/loan.model.js';
import {
  loanStatusFilter,
  problemsWithLoanDates,
  problemWithReturnDateCorrection,
} from '../src/modules/loans/loan.rules.js';
import {
  createLoanRequestSchema,
  listLoansQuerySchema,
  returnLoanRequestSchema,
  updateLoanRequestSchema,
} from '../src/modules/loans/loan.schema.js';
import { utcCalendarDateOf } from '../src/shared/calendar-date.js';
import { createTestApp } from './helpers.js';

const SOME_ID = '64b7f0c2a1b2c3d4e5f60718';

function invalidFields(result: { success: boolean; error?: { issues: object[] } }) {
  return (result.error?.issues ?? []).flatMap((issue) => {
    const { code, path, keys } = issue as { code: string; path: PropertyKey[]; keys?: string[] };
    return code === 'unrecognized_keys' ? (keys ?? []) : [path.join('.') || 'body'];
  });
}

describe('loan date rules', () => {
  it('accepts due and return dates on or after the lending date', () => {
    expect(
      problemsWithLoanDates({
        lentOn: '2026-11-14',
        dueOn: '2026-11-14',
        returnedOn: '2026-11-14',
      }),
    ).toEqual([]);
    expect(
      problemsWithLoanDates({ lentOn: '2026-11-14', dueOn: undefined, returnedOn: null }),
    ).toEqual([]);
    expect(
      problemsWithLoanDates({
        lentOn: '2026-11-14',
        dueOn: '2026-11-20',
        returnedOn: '2026-12-31',
      }),
    ).toEqual([]);
  });

  it('reports each date that precedes the lending date', () => {
    expect(
      problemsWithLoanDates({
        lentOn: '2026-11-14',
        dueOn: '2026-11-13',
        returnedOn: '2026-11-01',
      }),
    ).toEqual([
      { field: 'dueOn', message: 'must be on or after lentOn' },
      { field: 'returnedOn', message: 'must be on or after lentOn' },
    ]);
  });

  it('allows a return date correction only on a returned loan', () => {
    expect(problemWithReturnDateCorrection(null, undefined)).toEqual([]);
    expect(problemWithReturnDateCorrection('2026-11-20', '2026-11-21')).toEqual([]);
    expect(problemWithReturnDateCorrection(null, '2026-11-21')).toEqual([
      {
        field: 'returnedOn',
        message: 'can only be corrected on a returned loan; record the return first',
      },
    ]);
  });

  it('derives the UTC calendar day, not the local one', () => {
    expect(utcCalendarDateOf(new Date('2026-11-14T23:59:59.999Z'))).toBe('2026-11-14');
    expect(utcCalendarDateOf(new Date('2026-11-15T00:00:00.000Z'))).toBe('2026-11-15');
  });

  it('builds status filters so a loan due on the reference day is not overdue', () => {
    expect(loanStatusFilter('active', '2026-11-14')).toEqual({ returnedOn: null });
    expect(loanStatusFilter('returned', '2026-11-14')).toEqual({ returnedOn: { $ne: null } });
    expect(loanStatusFilter('overdue', '2026-11-14')).toEqual({
      returnedOn: null,
      dueOn: { $lt: '2026-11-14' },
    });
    expect(loanStatusFilter('all', '2026-11-14')).toEqual({});
  });
});

describe('loan request schemas', () => {
  it('trims borrower fields and keeps calendar dates as written', () => {
    expect(
      createLoanRequestSchema.parse({
        borrowerName: ' Ada ',
        borrowerContact: ' x ',
        lentOn: '2026-11-14',
        note: ' n ',
      }),
    ).toEqual({ borrowerName: 'Ada', borrowerContact: 'x', lentOn: '2026-11-14', note: 'n' });
  });

  it.each([
    [{ lentOn: '2026-11-14' }, ['borrowerName']],
    [{ borrowerName: 'Ada' }, ['lentOn']],
    [{ borrowerName: 'Ada', lentOn: '2026-02-30' }, ['lentOn']],
    [{ borrowerName: 'Ada', lentOn: '2026-11-14', returnedOn: null }, ['returnedOn']],
    [
      { borrowerName: 'Ada', lentOn: '2026-11-14', copyId: SOME_ID, ownerId: SOME_ID },
      ['copyId', 'ownerId'],
    ],
  ])('rejects %j on create', (body, fields) => {
    expect(invalidFields(createLoanRequestSchema.safeParse(body))).toEqual(fields);
  });

  it('allows clearing contact, due date and note but never the borrower, lending or return date', () => {
    expect(
      updateLoanRequestSchema.parse({ borrowerContact: null, dueOn: null, note: null }),
    ).toEqual({
      borrowerContact: null,
      dueOn: null,
      note: null,
    });
    expect(invalidFields(updateLoanRequestSchema.safeParse({ borrowerName: null }))).toEqual([
      'borrowerName',
    ]);
    expect(invalidFields(updateLoanRequestSchema.safeParse({ lentOn: null }))).toEqual(['lentOn']);
    expect(invalidFields(updateLoanRequestSchema.safeParse({ returnedOn: null }))).toEqual([
      'returnedOn',
    ]);
    expect(invalidFields(updateLoanRequestSchema.safeParse({}))).toEqual(['body']);
    expect(
      invalidFields(updateLoanRequestSchema.safeParse({ status: 'active', copyId: SOME_ID })),
    ).toEqual(['status', 'copyId']);
  });

  it('requires exactly a returnedOn calendar date for a return', () => {
    expect(returnLoanRequestSchema.parse({ returnedOn: '2026-11-20' })).toEqual({
      returnedOn: '2026-11-20',
    });
    for (const body of [
      {},
      { returnedOn: null },
      { returnedOn: '2026-11-31' },
      { returnedOn: '2026-11-20', note: 'x' },
    ]) {
      expect(returnLoanRequestSchema.safeParse(body).success).toBe(false);
    }
  });
});

describe('listLoansQuerySchema', () => {
  it('defaults to the first page of active loans, newest first', () => {
    expect(listLoansQuerySchema.parse({})).toEqual({
      page: 1,
      limit: 20,
      status: 'active',
      sort: 'recent',
    });
  });

  it('accepts asOf only together with the overdue status', () => {
    expect(listLoansQuerySchema.parse({ status: 'overdue', asOf: '2026-11-14' })).toMatchObject({
      asOf: '2026-11-14',
    });
    expect(listLoansQuerySchema.parse({ status: 'overdue' })).not.toHaveProperty('asOf');
    expect(invalidFields(listLoansQuerySchema.safeParse({ asOf: '2026-11-14' }))).toEqual(['asOf']);
    expect(
      invalidFields(listLoansQuerySchema.safeParse({ status: 'returned', asOf: '2026-11-14' })),
    ).toEqual(['asOf']);
    expect(
      invalidFields(listLoansQuerySchema.safeParse({ status: 'overdue', asOf: '2026-02-30' })),
    ).toEqual(['asOf']);
    expect(
      invalidFields(listLoansQuerySchema.safeParse({ status: 'late', asOf: '2026-11-14' })),
    ).toEqual(['status']);
  });

  it.each([
    { status: ['active', 'all'] },
    { sort: 'borrower' },
    { page: '0' },
    { limit: '101' },
    { copyId: SOME_ID },
  ])('rejects %j', (query) => {
    expect(listLoansQuerySchema.safeParse(query).success).toBe(false);
  });
});

describe('toPublicLoan', () => {
  const timestamp = new Date('2026-11-14T10:30:00.000Z');
  const record = {
    _id: new Types.ObjectId(SOME_ID),
    ownerId: new Types.ObjectId(),
    copyId: new Types.ObjectId('64b7f0c2a1b2c3d4e5f60719'),
    bookId: new Types.ObjectId('64b7f0c2a1b2c3d4e5f6071a'),
    borrowerName: 'Ada',
    lentOn: '2026-11-14',
    returnedOn: null,
    revision: 3,
    createdAt: timestamp,
    updatedAt: timestamp,
  } as unknown as LoanRecord;

  it('exposes exactly the public fields and always includes returnedOn', () => {
    expect(toPublicLoan(record)).toEqual({
      id: SOME_ID,
      copyId: '64b7f0c2a1b2c3d4e5f60719',
      bookId: '64b7f0c2a1b2c3d4e5f6071a',
      borrowerName: 'Ada',
      lentOn: '2026-11-14',
      returnedOn: null,
      createdAt: '2026-11-14T10:30:00.000Z',
      updatedAt: '2026-11-14T10:30:00.000Z',
    });
    const returned = toPublicLoan({
      ...record,
      returnedOn: '2026-11-20',
      dueOn: '2026-11-15',
      note: 'n',
    });
    expect(returned).toMatchObject({ returnedOn: '2026-11-20', dueOn: '2026-11-15', note: 'n' });
    for (const internal of ['ownerId', 'revision', '_id'])
      expect(returned).not.toHaveProperty(internal);
  });
});

describe('loan endpoints without authentication', () => {
  it.each([
    ['POST', `/api/v1/copies/${SOME_ID}/loans`],
    ['GET', `/api/v1/copies/${SOME_ID}/loans`],
    ['GET', `/api/v1/copies/${SOME_ID}/loan-overview`],
    ['GET', '/api/v1/loans'],
    ['GET', `/api/v1/loans/${SOME_ID}`],
    ['PATCH', `/api/v1/loans/${SOME_ID}`],
    ['PUT', `/api/v1/loans/${SOME_ID}/return`],
  ])('%s %s returns 401 UNAUTHENTICATED without caching', async (method, path) => {
    const res = await request(createTestApp())[method.toLowerCase() as 'get'](path).send({});

    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toBe('Bearer');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('sends no-store for malformed bodies, preflight and loan deletion attempts', async () => {
    const app = createTestApp();

    const malformed = await request(app)
      .put(`/api/v1/loans/${SOME_ID}/return`)
      .set('Content-Type', 'application/json')
      .send('{"returnedOn": ');
    const preflight = await request(app)
      .options('/api/v1/loans')
      .set('Origin', 'http://localhost:5173')
      .set('Access-Control-Request-Method', 'PATCH');
    const deletion = await request(app).delete(`/api/v1/loans/${SOME_ID}`);

    expect(malformed.status).toBe(400);
    expect(preflight.status).toBe(204);
    expect(deletion.status).toBe(404);
    expect(deletion.body.error.message).toBe('Route not found');
    for (const res of [malformed, preflight, deletion])
      expect(res.headers['cache-control']).toBe('no-store');
  });
});
