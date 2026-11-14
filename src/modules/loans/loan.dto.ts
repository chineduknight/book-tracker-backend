import type { PaginatedResponseBody, SuccessResponseBody } from '../../shared/api-response.js';
import type { LoanRecord } from './loan.model.js';

export interface LoanDto {
  id: string;
  copyId: string;
  bookId: string;
  borrowerName: string;
  borrowerContact?: string;
  lentOn: string;
  dueOn?: string;
  returnedOn: string | null;
  note?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CopyLoanOverviewDto {
  copyId: string;
  isOnLoan: boolean;
  activeLoan: LoanDto | null;
}

export type LoanResponseBody = SuccessResponseBody<LoanDto>;
export type LoanListResponseBody = PaginatedResponseBody<LoanDto>;
export type CopyLoanOverviewResponseBody = SuccessResponseBody<CopyLoanOverviewDto>;

export function toPublicLoan(loan: LoanRecord): LoanDto {
  return {
    id: loan._id.toHexString(),
    copyId: loan.copyId.toHexString(),
    bookId: loan.bookId.toHexString(),
    borrowerName: loan.borrowerName,
    ...(loan.borrowerContact != null && { borrowerContact: loan.borrowerContact }),
    lentOn: loan.lentOn,
    ...(loan.dueOn != null && { dueOn: loan.dueOn }),
    returnedOn: loan.returnedOn ?? null,
    ...(loan.note != null && { note: loan.note }),
    createdAt: loan.createdAt.toISOString(),
    updatedAt: loan.updatedAt.toISOString(),
  };
}
