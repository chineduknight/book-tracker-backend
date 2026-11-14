import { Router, type Request, type RequestHandler } from 'express';
import {
  parseRequestBody,
  parseRequestQuery,
  parseRouteParams,
} from '../../shared/request-validation.js';
import { authenticatedUserOf } from '../auth/auth.middleware.js';
import type {
  CopyLoanOverviewResponseBody,
  LoanListResponseBody,
  LoanResponseBody,
} from './loan.dto.js';
import {
  copyLoansParamsSchema,
  createLoanRequestSchema,
  listLoansQuerySchema,
  loanIdParamsSchema,
  returnLoanRequestSchema,
  updateLoanRequestSchema,
} from './loan.schema.js';
import {
  createLoan,
  findCopyLoanOverview,
  findLoanOwnedByUser,
  listLoansOfCopy,
  listLoansOfOwner,
  returnLoanOwnedByUser,
  updateLoanOwnedByUser,
} from './loan.service.js';

export interface LoansRouterDependencies {
  requireAuthenticatedUser: RequestHandler;
}

function ownerIdOf(req: Request): string {
  return authenticatedUserOf(req).userId;
}

function copyIdOf(req: Request): string {
  return parseRouteParams(copyLoansParamsSchema, req.params).copyId;
}

function loanIdOf(req: Request): string {
  return parseRouteParams(loanIdParamsSchema, req.params).loanId;
}

/** Serves copy-scoped and global loan routes; mount it before the copies router. */
export function createLoansRouter({ requireAuthenticatedUser }: LoansRouterDependencies): Router {
  const loansRouter = Router();

  loansRouter.post('/copies/:copyId/loans', requireAuthenticatedUser, async (req, res) => {
    const copyId = copyIdOf(req);
    const newLoan = parseRequestBody(createLoanRequestSchema, req.body);
    const loan = await createLoan(ownerIdOf(req), copyId, newLoan);
    res
      .status(201)
      .location(`${req.baseUrl}/loans/${loan.id}`)
      .json({ data: loan } satisfies LoanResponseBody);
  });

  loansRouter.get('/copies/:copyId/loans', requireAuthenticatedUser, async (req, res) => {
    const copyId = copyIdOf(req);
    const listQuery = parseRequestQuery(listLoansQuerySchema, req.query);
    const { loans, pagination } = await listLoansOfCopy(ownerIdOf(req), copyId, listQuery);
    res.status(200).json({ data: loans, meta: { pagination } } satisfies LoanListResponseBody);
  });

  loansRouter.get('/copies/:copyId/loan-overview', requireAuthenticatedUser, async (req, res) => {
    const overview = await findCopyLoanOverview(ownerIdOf(req), copyIdOf(req));
    res.status(200).json({ data: overview } satisfies CopyLoanOverviewResponseBody);
  });

  loansRouter.get('/loans', requireAuthenticatedUser, async (req, res) => {
    const listQuery = parseRequestQuery(listLoansQuerySchema, req.query);
    const { loans, pagination } = await listLoansOfOwner(ownerIdOf(req), listQuery);
    res.status(200).json({ data: loans, meta: { pagination } } satisfies LoanListResponseBody);
  });

  loansRouter.get('/loans/:loanId', requireAuthenticatedUser, async (req, res) => {
    const loan = await findLoanOwnedByUser(ownerIdOf(req), loanIdOf(req));
    res.status(200).json({ data: loan } satisfies LoanResponseBody);
  });

  loansRouter.patch('/loans/:loanId', requireAuthenticatedUser, async (req, res) => {
    const loanId = loanIdOf(req);
    const changes = parseRequestBody(updateLoanRequestSchema, req.body);
    const loan = await updateLoanOwnedByUser(ownerIdOf(req), loanId, changes);
    res.status(200).json({ data: loan } satisfies LoanResponseBody);
  });

  loansRouter.put('/loans/:loanId/return', requireAuthenticatedUser, async (req, res) => {
    const loanId = loanIdOf(req);
    const loanReturn = parseRequestBody(returnLoanRequestSchema, req.body);
    const loan = await returnLoanOwnedByUser(ownerIdOf(req), loanId, loanReturn);
    res.status(200).json({ data: loan } satisfies LoanResponseBody);
  });

  return loansRouter;
}
