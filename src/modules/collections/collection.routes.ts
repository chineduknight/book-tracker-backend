import { Router, type Request, type RequestHandler } from 'express';
import {
  parseRequestBody,
  parseRequestQuery,
  parseRouteParams,
} from '../../shared/request-validation.js';
import { authenticatedUserOf } from '../auth/auth.middleware.js';
import type { BookListResponseBody } from '../books/book.dto.js';
import type {
  BookCollectionListResponseBody,
  BookCollectionResponseBody,
} from './collection.dto.js';
import {
  collectionBookParamsSchema,
  collectionIdParamsSchema,
  createCollectionRequestSchema,
  listCollectionsQuerySchema,
  updateCollectionRequestSchema,
} from './collection.schema.js';
import {
  addBookToCollection,
  createCollection,
  deleteCollectionOwnedByUser,
  findCollectionOwnedByUser,
  listBooksInCollection,
  listCollectionsOwnedByUser,
  removeBookFromCollection,
  updateCollectionOwnedByUser,
} from './collection.service.js';

export interface CollectionsRouterDependencies {
  requireAuthenticatedUser: RequestHandler;
}

function ownerIdOf(req: Request): string {
  return authenticatedUserOf(req).userId;
}

function collectionIdOf(req: Request): string {
  return parseRouteParams(collectionIdParamsSchema, req.params).collectionId;
}

function membershipOf(req: Request) {
  return parseRouteParams(collectionBookParamsSchema, req.params);
}

export function createCollectionsRouter({
  requireAuthenticatedUser,
}: CollectionsRouterDependencies): Router {
  const collectionsRouter = Router();

  collectionsRouter.use(requireAuthenticatedUser);

  collectionsRouter.post('/', async (req, res) => {
    const newCollection = parseRequestBody(createCollectionRequestSchema, req.body);
    const collection = await createCollection(ownerIdOf(req), newCollection);
    res
      .status(201)
      .location(`${req.baseUrl}/${collection.id}`)
      .json({ data: collection } satisfies BookCollectionResponseBody);
  });

  collectionsRouter.get('/', async (req, res) => {
    const listQuery = parseRequestQuery(listCollectionsQuerySchema, req.query);
    const { collections, pagination } = await listCollectionsOwnedByUser(ownerIdOf(req), listQuery);
    res
      .status(200)
      .json({ data: collections, meta: { pagination } } satisfies BookCollectionListResponseBody);
  });

  collectionsRouter.get('/:collectionId', async (req, res) => {
    const collection = await findCollectionOwnedByUser(ownerIdOf(req), collectionIdOf(req));
    res.status(200).json({ data: collection } satisfies BookCollectionResponseBody);
  });

  collectionsRouter.patch('/:collectionId', async (req, res) => {
    const collectionId = collectionIdOf(req);
    const changes = parseRequestBody(updateCollectionRequestSchema, req.body);
    const collection = await updateCollectionOwnedByUser(ownerIdOf(req), collectionId, changes);
    res.status(200).json({ data: collection } satisfies BookCollectionResponseBody);
  });

  collectionsRouter.delete('/:collectionId', async (req, res) => {
    await deleteCollectionOwnedByUser(ownerIdOf(req), collectionIdOf(req));
    res.status(204).end();
  });

  collectionsRouter.put('/:collectionId/books/:bookId', async (req, res) => {
    const { collectionId, bookId } = membershipOf(req);
    await addBookToCollection(ownerIdOf(req), collectionId, bookId);
    res.status(204).end();
  });

  collectionsRouter.delete('/:collectionId/books/:bookId', async (req, res) => {
    const { collectionId, bookId } = membershipOf(req);
    await removeBookFromCollection(ownerIdOf(req), collectionId, bookId);
    res.status(204).end();
  });

  collectionsRouter.get('/:collectionId/books', async (req, res) => {
    const collectionId = collectionIdOf(req);
    const pageQuery = parseRequestQuery(listCollectionsQuerySchema, req.query);
    const { books, pagination } = await listBooksInCollection(
      ownerIdOf(req),
      collectionId,
      pageQuery,
    );
    res.status(200).json({ data: books, meta: { pagination } } satisfies BookListResponseBody);
  });

  return collectionsRouter;
}
