import type { FieldValidationError } from '../../shared/request-validation.js';
import type { LoanStatusFilter } from './loan.schema.js';

export interface LoanDates {
  lentOn: string;
  dueOn: string | undefined;
  returnedOn: string | null;
}

/** Calendar dates are `YYYY-MM-DD`, so string order is chronological order. */
export function problemsWithLoanDates({
  lentOn,
  dueOn,
  returnedOn,
}: LoanDates): FieldValidationError[] {
  const problems: FieldValidationError[] = [];
  if (dueOn !== undefined && dueOn < lentOn) {
    problems.push({ field: 'dueOn', message: 'must be on or after lentOn' });
  }
  if (returnedOn !== null && returnedOn < lentOn) {
    problems.push({ field: 'returnedOn', message: 'must be on or after lentOn' });
  }
  return problems;
}

export function problemWithReturnDateCorrection(
  currentReturnedOn: string | null,
  requestedReturnedOn: string | undefined,
): FieldValidationError[] {
  if (requestedReturnedOn === undefined || currentReturnedOn !== null) return [];
  return [
    {
      field: 'returnedOn',
      message: 'can only be corrected on a returned loan; record the return first',
    },
  ];
}

export function loanStatusFilter(status: LoanStatusFilter, asOf: string) {
  switch (status) {
    case 'active':
      return { returnedOn: null };
    case 'returned':
      return { returnedOn: { $ne: null } };
    case 'overdue':
      return { returnedOn: null, dueOn: { $lt: asOf } };
    case 'all':
      return {};
  }
}
