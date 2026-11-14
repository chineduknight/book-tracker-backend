import { isDuplicateKeyError } from '../../db/mongo.js';
import { toPaginationMeta, type PaginationMeta } from '../../shared/api-response.js';
import { AppError } from '../../shared/errors.js';
import { invalidFieldsError } from '../../shared/request-validation.js';
import { requireVisibleCopyBookIdOwnedByUser } from '../copies/copy.service.js';
import { toPublicLoan, type CopyLoanOverviewDto, type LoanDto } from './loan.dto.js';
import { LoanModel, type LoanRecord } from './loan.model.js';
import {
  loanStatusFilter,
  problemsWithLoanDates,
  problemWithReturnDateCorrection,
  utcCalendarDateOf,
} from './loan.rules.js';
import type { LoanChanges, LoanListQuery, LoanReturn, NewLoan } from './loan.schema.js';

const MAX_UPDATE_ATTEMPTS = 5;
const SORT_ORDERS = {
  recent: { createdAt: -1, _id: -1 },
  oldest: { createdAt: 1, _id: 1 },
} as const;

export interface LoanPage {
  loans: LoanDto[];
  pagination: PaginationMeta;
}

function loanNotFoundError(): AppError {
  return new AppError(404, 'NOT_FOUND', 'Loan not found');
}

function copyAlreadyOnLoanError(): AppError {
  return new AppError(409, 'COPY_ALREADY_ON_LOAN', 'This copy already has an active loan');
}

function loanAlreadyReturnedError(): AppError {
  return new AppError(
    409,
    'LOAN_ALREADY_RETURNED',
    'This loan was already returned on a different date; correct the date with PATCH',
  );
}

function loanUpdateConflictError(): AppError {
  return new AppError(
    409,
    'LOAN_UPDATE_CONFLICT',
    'The loan kept changing during the update; try again',
  );
}

function loanOwnedBy(ownerId: string, loanId: string) {
  return { _id: loanId, ownerId };
}

function valueAfterChange<Value>(
  change: Value | null | undefined,
  current: Value | null | undefined,
): Value | undefined {
  if (change === undefined) return current ?? undefined;
  return change ?? undefined;
}

function rejectInvalidLoanDates(
  lentOn: string,
  dueOn: string | undefined,
  returnedOn: string | null,
) {
  const problems = problemsWithLoanDates({ lentOn, dueOn, returnedOn });
  if (problems.length > 0) throw invalidFieldsError(problems);
}

function toLoanUpdate(changes: LoanChanges) {
  const fieldsToSet: Record<string, unknown> = {};
  const fieldsToClear: Record<string, ''> = {};

  for (const [field, value] of Object.entries(changes)) {
    if (value === null) fieldsToClear[field] = '';
    else fieldsToSet[field] = value;
  }

  return { $set: fieldsToSet, $unset: fieldsToClear, $inc: { revision: 1 } };
}

type StoredLoan = LoanRecord & { returnedOn: string | null };

async function requireLoanOwnedByUser(ownerId: string, loanId: string): Promise<StoredLoan> {
  const loan = await LoanModel.findOne(loanOwnedBy(ownerId, loanId)).lean();
  if (!loan) throw loanNotFoundError();
  return { ...loan, returnedOn: loan.returnedOn ?? null };
}

function toStatusFilter({ status, asOf }: LoanListQuery) {
  return loanStatusFilter(status, asOf ?? utcCalendarDateOf(new Date()));
}

async function pageOfLoans(
  filter: Record<string, unknown>,
  { page, limit, sort }: LoanListQuery,
): Promise<LoanPage> {
  const [loans, total] = await Promise.all([
    LoanModel.find(filter)
      .sort(SORT_ORDERS[sort])
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    LoanModel.countDocuments(filter),
  ]);
  return { loans: loans.map(toPublicLoan), pagination: toPaginationMeta(page, limit, total) };
}

/*
 * The partial unique index on { ownerId, copyId } where returnedOn is null decides concurrent
 * lends of one copy: the insert that loses becomes 409, never a second active loan.
 */
export async function createLoan(
  ownerId: string,
  copyId: string,
  newLoan: NewLoan,
): Promise<LoanDto> {
  const bookId = await requireVisibleCopyBookIdOwnedByUser(ownerId, copyId);
  rejectInvalidLoanDates(newLoan.lentOn, newLoan.dueOn, null);

  try {
    const loan = await new LoanModel({
      ...newLoan,
      ownerId,
      copyId,
      bookId,
      returnedOn: null,
    }).save();
    return toPublicLoan(loan.toObject());
  } catch (error) {
    if (isDuplicateKeyError(error)) throw copyAlreadyOnLoanError();
    throw error;
  }
}

export async function listLoansOfCopy(
  ownerId: string,
  copyId: string,
  query: LoanListQuery,
): Promise<LoanPage> {
  await requireVisibleCopyBookIdOwnedByUser(ownerId, copyId);
  return pageOfLoans({ ownerId, copyId, ...toStatusFilter(query) }, query);
}

/*
 * Deliberately no join on active books or copies: a loan is an obligation owed to the reader,
 * so it stays listed and returnable after its copy or book is deleted.
 */
export async function listLoansOfOwner(ownerId: string, query: LoanListQuery): Promise<LoanPage> {
  return pageOfLoans({ ownerId, ...toStatusFilter(query) }, query);
}

export async function findCopyLoanOverview(
  ownerId: string,
  copyId: string,
): Promise<CopyLoanOverviewDto> {
  await requireVisibleCopyBookIdOwnedByUser(ownerId, copyId);
  const activeLoan = await LoanModel.findOne({ ownerId, copyId, returnedOn: null }).lean();
  return {
    copyId,
    isOnLoan: activeLoan !== null,
    activeLoan: activeLoan ? toPublicLoan(activeLoan) : null,
  };
}

export async function findLoanOwnedByUser(ownerId: string, loanId: string): Promise<LoanDto> {
  return toPublicLoan(await requireLoanOwnedByUser(ownerId, loanId));
}

/*
 * Date rules are checked against the merged state the write applies to: the update only matches
 * the revision that was validated, so a concurrent change makes the request re-read and
 * re-validate instead of writing chronology it never checked.
 */
export async function updateLoanOwnedByUser(
  ownerId: string,
  loanId: string,
  changes: LoanChanges,
): Promise<LoanDto> {
  for (let attempt = 1; attempt <= MAX_UPDATE_ATTEMPTS; attempt += 1) {
    const loan = await requireLoanOwnedByUser(ownerId, loanId);
    const problems = [
      ...problemWithReturnDateCorrection(loan.returnedOn, changes.returnedOn),
      ...problemsWithLoanDates({
        lentOn: changes.lentOn ?? loan.lentOn,
        dueOn: valueAfterChange(changes.dueOn, loan.dueOn),
        returnedOn: changes.returnedOn ?? loan.returnedOn,
      }),
    ];
    if (problems.length > 0) throw invalidFieldsError(problems);

    const updatedLoan = await LoanModel.findOneAndUpdate(
      { ...loanOwnedBy(ownerId, loanId), revision: loan.revision },
      toLoanUpdate(changes),
      { returnDocument: 'after', runValidators: true },
    ).lean();
    if (updatedLoan) return toPublicLoan(updatedLoan);
  }
  throw loanUpdateConflictError();
}

export async function returnLoanOwnedByUser(
  ownerId: string,
  loanId: string,
  { returnedOn }: LoanReturn,
): Promise<LoanDto> {
  for (let attempt = 1; attempt <= MAX_UPDATE_ATTEMPTS; attempt += 1) {
    const loan = await requireLoanOwnedByUser(ownerId, loanId);
    if (loan.returnedOn !== null) {
      if (loan.returnedOn === returnedOn) return toPublicLoan(loan);
      throw loanAlreadyReturnedError();
    }
    rejectInvalidLoanDates(loan.lentOn, loan.dueOn ?? undefined, returnedOn);

    const returnedLoan = await LoanModel.findOneAndUpdate(
      { ...loanOwnedBy(ownerId, loanId), revision: loan.revision, returnedOn: null },
      { $set: { returnedOn }, $inc: { revision: 1 } },
      { returnDocument: 'after' },
    ).lean();
    if (returnedLoan) return toPublicLoan(returnedLoan);
  }
  throw loanUpdateConflictError();
}
