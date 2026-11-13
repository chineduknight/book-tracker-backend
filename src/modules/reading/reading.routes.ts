import { Router, type Request, type RequestHandler } from 'express';
import {
  parseRequestBody,
  parseRequestQuery,
  parseRouteParams,
} from '../../shared/request-validation.js';
import { authenticatedUserOf } from '../auth/auth.middleware.js';
import type {
  BookReadingOverviewResponseBody,
  ReadingSessionListResponseBody,
  ReadingSessionResponseBody,
} from './reading.dto.js';
import {
  bookReadingParamsSchema,
  readingHistoryQuerySchema,
  readingSessionIdParamsSchema,
  startReadingSessionRequestSchema,
  updateReadingSessionRequestSchema,
} from './reading.schema.js';
import {
  findReadingOverview,
  findReadingSessionOwnedByUser,
  listReadingSessionsOfBook,
  listReadingSessionsOfOwner,
  startReadingSession,
  updateReadingSessionOwnedByUser,
} from './reading.service.js';

export interface ReadingRouterDependencies {
  requireAuthenticatedUser: RequestHandler;
}

function ownerIdOf(req: Request): string {
  return authenticatedUserOf(req).userId;
}

function bookIdOf(req: Request): string {
  return parseRouteParams(bookReadingParamsSchema, req.params).bookId;
}

function sessionIdOf(req: Request): string {
  return parseRouteParams(readingSessionIdParamsSchema, req.params).sessionId;
}

/** Serves book-scoped and global reading routes; mount it before the books router. */
export function createReadingRouter({
  requireAuthenticatedUser,
}: ReadingRouterDependencies): Router {
  const readingRouter = Router();

  readingRouter.post(
    '/books/:bookId/reading-sessions',
    requireAuthenticatedUser,
    async (req, res) => {
      const bookId = bookIdOf(req);
      const newSession = parseRequestBody(startReadingSessionRequestSchema, req.body);
      const session = await startReadingSession(ownerIdOf(req), bookId, newSession);
      res
        .status(201)
        .location(`${req.baseUrl}/reading-sessions/${session.id}`)
        .json({ data: session } satisfies ReadingSessionResponseBody);
    },
  );

  readingRouter.get(
    '/books/:bookId/reading-sessions',
    requireAuthenticatedUser,
    async (req, res) => {
      const bookId = bookIdOf(req);
      const historyQuery = parseRequestQuery(readingHistoryQuerySchema, req.query);
      const { sessions, pagination } = await listReadingSessionsOfBook(
        ownerIdOf(req),
        bookId,
        historyQuery,
      );
      res
        .status(200)
        .json({ data: sessions, meta: { pagination } } satisfies ReadingSessionListResponseBody);
    },
  );

  readingRouter.get(
    '/books/:bookId/reading-overview',
    requireAuthenticatedUser,
    async (req, res) => {
      const overview = await findReadingOverview(ownerIdOf(req), bookIdOf(req));
      res.status(200).json({ data: overview } satisfies BookReadingOverviewResponseBody);
    },
  );

  readingRouter.get('/reading-sessions', requireAuthenticatedUser, async (req, res) => {
    const historyQuery = parseRequestQuery(readingHistoryQuerySchema, req.query);
    const { sessions, pagination } = await listReadingSessionsOfOwner(ownerIdOf(req), historyQuery);
    res
      .status(200)
      .json({ data: sessions, meta: { pagination } } satisfies ReadingSessionListResponseBody);
  });

  readingRouter.get('/reading-sessions/:sessionId', requireAuthenticatedUser, async (req, res) => {
    const session = await findReadingSessionOwnedByUser(ownerIdOf(req), sessionIdOf(req));
    res.status(200).json({ data: session } satisfies ReadingSessionResponseBody);
  });

  readingRouter.patch(
    '/reading-sessions/:sessionId',
    requireAuthenticatedUser,
    async (req, res) => {
      const sessionId = sessionIdOf(req);
      const changes = parseRequestBody(updateReadingSessionRequestSchema, req.body);
      const session = await updateReadingSessionOwnedByUser(ownerIdOf(req), sessionId, changes);
      res.status(200).json({ data: session } satisfies ReadingSessionResponseBody);
    },
  );

  return readingRouter;
}
