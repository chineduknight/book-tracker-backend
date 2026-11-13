import { Router, type Request, type RequestHandler } from 'express';
import {
  parseRequestBody,
  parseRequestQuery,
  parseRouteParams,
} from '../../shared/request-validation.js';
import { authenticatedUserOf } from '../auth/auth.middleware.js';
import type {
  BookListResponseBody,
  BookResponseBody,
  DuplicateCheckResponseBody,
} from './book.dto.js';
import {
  bookIdParamsSchema,
  createBookRequestSchema,
  duplicateCheckQuerySchema,
  listBooksQuerySchema,
  updateBookRequestSchema,
} from './book.schema.js';
import {
  createBook,
  deleteBookOwnedByUser,
  findBookOwnedByUser,
  findPossibleDuplicateBooks,
  listBooksOwnedByUser,
  updateBookOwnedByUser,
} from './book.service.js';

export interface BooksRouterDependencies {
  requireAuthenticatedUser: RequestHandler;
}

function ownerIdOf(req: Request): string {
  return authenticatedUserOf(req).userId;
}

function bookIdOf(req: Request): string {
  return parseRouteParams(bookIdParamsSchema, req.params).bookId;
}

export function createBooksRouter({ requireAuthenticatedUser }: BooksRouterDependencies): Router {
  const booksRouter = Router();

  booksRouter.use(requireAuthenticatedUser);

  booksRouter.post('/', async (req, res) => {
    const newBook = parseRequestBody(createBookRequestSchema, req.body);
    const book = await createBook(ownerIdOf(req), newBook);
    res
      .status(201)
      .location(`${req.baseUrl}/${book.id}`)
      .json({ data: book } satisfies BookResponseBody);
  });

  booksRouter.get('/', async (req, res) => {
    const listQuery = parseRequestQuery(listBooksQuerySchema, req.query);
    const { books, pagination } = await listBooksOwnedByUser(ownerIdOf(req), listQuery);
    res.status(200).json({ data: books, meta: { pagination } } satisfies BookListResponseBody);
  });

  booksRouter.get('/duplicate-check', async (req, res) => {
    const duplicateQuery = parseRequestQuery(duplicateCheckQuerySchema, req.query);
    const matches = await findPossibleDuplicateBooks(ownerIdOf(req), duplicateQuery);
    res.status(200).json({ data: { matches } } satisfies DuplicateCheckResponseBody);
  });

  booksRouter.get('/:bookId', async (req, res) => {
    const book = await findBookOwnedByUser(ownerIdOf(req), bookIdOf(req));
    res.status(200).json({ data: book } satisfies BookResponseBody);
  });

  booksRouter.patch('/:bookId', async (req, res) => {
    const bookId = bookIdOf(req);
    const changes = parseRequestBody(updateBookRequestSchema, req.body);
    const book = await updateBookOwnedByUser(ownerIdOf(req), bookId, changes);
    res.status(200).json({ data: book } satisfies BookResponseBody);
  });

  booksRouter.delete('/:bookId', async (req, res) => {
    await deleteBookOwnedByUser(ownerIdOf(req), bookIdOf(req));
    res.status(204).end();
  });

  return booksRouter;
}
