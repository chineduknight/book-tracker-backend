import { Router, type RequestHandler } from 'express';
import { parseRouteParams } from '../../shared/request-validation.js';
import { authenticatedUserOf } from '../auth/auth.middleware.js';
import { bookIdParamsSchema } from '../books/book.schema.js';
import type { BookOrganizationResponseBody } from './organization.dto.js';
import { findBookOrganization } from './organization.service.js';

export interface OrganizationRouterDependencies {
  requireAuthenticatedUser: RequestHandler;
}

/** Serves the reverse lookup from a book to its groups; mount it before the books router. */
export function createOrganizationRouter({
  requireAuthenticatedUser,
}: OrganizationRouterDependencies): Router {
  const organizationRouter = Router();

  organizationRouter.get(
    '/books/:bookId/organization',
    requireAuthenticatedUser,
    async (req, res) => {
      const { bookId } = parseRouteParams(bookIdParamsSchema, req.params);
      const organization = await findBookOrganization(authenticatedUserOf(req).userId, bookId);
      res.status(200).json({ data: organization } satisfies BookOrganizationResponseBody);
    },
  );

  return organizationRouter;
}
