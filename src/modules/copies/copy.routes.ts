import { Router, type Request, type RequestHandler } from 'express';
import {
  parseRequestBody,
  parseRequestQuery,
  parseRouteParams,
} from '../../shared/request-validation.js';
import { authenticatedUserOf } from '../auth/auth.middleware.js';
import type { PhysicalCopyListResponseBody, PhysicalCopyResponseBody } from './copy.dto.js';
import {
  bookCopiesParamsSchema,
  copyIdParamsSchema,
  createCopyRequestSchema,
  listCopiesQuerySchema,
  updateCopyRequestSchema,
} from './copy.schema.js';
import {
  createPhysicalCopy,
  deleteCopyOwnedByUser,
  findCopyOwnedByUser,
  listCopiesOfBook,
  updateCopyOwnedByUser,
} from './copy.service.js';

export interface CopiesRouterDependencies {
  requireAuthenticatedUser: RequestHandler;
}

function ownerIdOf(req: Request): string {
  return authenticatedUserOf(req).userId;
}

function bookIdOf(req: Request): string {
  return parseRouteParams(bookCopiesParamsSchema, req.params).bookId;
}

function copyIdOf(req: Request): string {
  return parseRouteParams(copyIdParamsSchema, req.params).copyId;
}

/** Serves `/books/:bookId/copies` and `/copies/:copyId`; mount it before the books router. */
export function createCopiesRouter({ requireAuthenticatedUser }: CopiesRouterDependencies): Router {
  const copiesRouter = Router();

  copiesRouter.post('/books/:bookId/copies', requireAuthenticatedUser, async (req, res) => {
    const bookId = bookIdOf(req);
    const newCopy = parseRequestBody(createCopyRequestSchema, req.body);
    const copy = await createPhysicalCopy(ownerIdOf(req), bookId, newCopy);
    res
      .status(201)
      .location(`${req.baseUrl}/copies/${copy.id}`)
      .json({ data: copy } satisfies PhysicalCopyResponseBody);
  });

  copiesRouter.get('/books/:bookId/copies', requireAuthenticatedUser, async (req, res) => {
    const bookId = bookIdOf(req);
    const listQuery = parseRequestQuery(listCopiesQuerySchema, req.query);
    const { copies, pagination } = await listCopiesOfBook(ownerIdOf(req), bookId, listQuery);
    res
      .status(200)
      .json({ data: copies, meta: { pagination } } satisfies PhysicalCopyListResponseBody);
  });

  copiesRouter.get('/copies/:copyId', requireAuthenticatedUser, async (req, res) => {
    const copy = await findCopyOwnedByUser(ownerIdOf(req), copyIdOf(req));
    res.status(200).json({ data: copy } satisfies PhysicalCopyResponseBody);
  });

  copiesRouter.patch('/copies/:copyId', requireAuthenticatedUser, async (req, res) => {
    const copyId = copyIdOf(req);
    const changes = parseRequestBody(updateCopyRequestSchema, req.body);
    const copy = await updateCopyOwnedByUser(ownerIdOf(req), copyId, changes);
    res.status(200).json({ data: copy } satisfies PhysicalCopyResponseBody);
  });

  copiesRouter.delete('/copies/:copyId', requireAuthenticatedUser, async (req, res) => {
    await deleteCopyOwnedByUser(ownerIdOf(req), copyIdOf(req));
    res.status(204).end();
  });

  return copiesRouter;
}
