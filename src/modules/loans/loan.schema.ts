import { z } from 'zod';
import { calendarDateSchema } from '../../shared/calendar-date.js';
import {
  limitQueryParameter,
  objectIdSchema,
  pageQueryParameter,
  requiringAtLeastOneChange,
  singleQueryChoice,
  singleQueryValue,
} from '../../shared/request-schemas.js';

export const LOAN_STATUS_FILTERS = ['active', 'returned', 'overdue', 'all'] as const;
const LOAN_SORT_ORDERS = ['recent', 'oldest'] as const;

const borrowerName = z.string().trim().min(1).max(160);
const borrowerContact = z.string().trim().min(1).max(200);
const note = z.string().trim().min(1).max(2_000);

export const createLoanRequestSchema = z.strictObject({
  borrowerName,
  borrowerContact: borrowerContact.optional(),
  lentOn: calendarDateSchema,
  dueOn: calendarDateSchema.optional(),
  note: note.optional(),
});

export const updateLoanRequestSchema = requiringAtLeastOneChange(
  z.strictObject({
    borrowerName: borrowerName.optional(),
    borrowerContact: borrowerContact.nullable().optional(),
    lentOn: calendarDateSchema.optional(),
    dueOn: calendarDateSchema.nullable().optional(),
    note: note.nullable().optional(),
    returnedOn: calendarDateSchema.optional(),
  }),
);

export const returnLoanRequestSchema = z.strictObject({ returnedOn: calendarDateSchema });

const isIssueWithStatusOrAsOf = (issue: z.core.$ZodRawIssue) =>
  issue.path?.[0] === 'status' || issue.path?.[0] === 'asOf';

export const listLoansQuerySchema = z
  .strictObject({
    page: pageQueryParameter,
    limit: limitQueryParameter,
    status: singleQueryChoice(LOAN_STATUS_FILTERS).default('active'),
    sort: singleQueryChoice(LOAN_SORT_ORDERS).default('recent'),
    asOf: singleQueryValue.pipe(calendarDateSchema).optional(),
  })
  .superRefine(
    (query, context) => {
      if (query.asOf !== undefined && query.status !== 'overdue') {
        context.addIssue({
          code: 'custom',
          path: ['asOf'],
          message: 'is only accepted together with status=overdue',
        });
      }
    },
    { when: (payload) => !payload.issues.some(isIssueWithStatusOrAsOf) },
  );

export const copyLoansParamsSchema = z.strictObject({ copyId: objectIdSchema });
export const loanIdParamsSchema = z.strictObject({ loanId: objectIdSchema });

export type LoanStatusFilter = (typeof LOAN_STATUS_FILTERS)[number];
export type NewLoan = z.output<typeof createLoanRequestSchema>;
export type LoanChanges = z.output<typeof updateLoanRequestSchema>;
export type LoanReturn = z.output<typeof returnLoanRequestSchema>;
export type LoanListQuery = z.output<typeof listLoansQuerySchema>;
