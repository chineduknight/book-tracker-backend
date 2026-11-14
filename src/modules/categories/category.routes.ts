import { Router, type Request, type RequestHandler } from 'express';
import {
  parseRequestBody,
  parseRequestQuery,
  parseRouteParams,
} from '../../shared/request-validation.js';
import { authenticatedUserOf } from '../auth/auth.middleware.js';
import type { BookListResponseBody } from '../books/book.dto.js';
import type {
  CategoryListResponseBody,
  CategoryPresetsResponseBody,
  CategoryResponseBody,
} from './category.dto.js';
import { CATEGORY_PRESET_NAMES } from './category.presets.js';
import {
  categoryBookParamsSchema,
  categoryIdParamsSchema,
  createCategoryRequestSchema,
  listCategoriesQuerySchema,
  updateCategoryRequestSchema,
} from './category.schema.js';
import {
  addBookToCategory,
  createCategory,
  deleteCategoryOwnedByUser,
  findCategoryOwnedByUser,
  listBooksInCategory,
  listCategoriesOwnedByUser,
  removeBookFromCategory,
  updateCategoryOwnedByUser,
} from './category.service.js';

export interface CategoriesRouterDependencies {
  requireAuthenticatedUser: RequestHandler;
}

function ownerIdOf(req: Request): string {
  return authenticatedUserOf(req).userId;
}

function categoryIdOf(req: Request): string {
  return parseRouteParams(categoryIdParamsSchema, req.params).categoryId;
}

function membershipOf(req: Request) {
  return parseRouteParams(categoryBookParamsSchema, req.params);
}

export function createCategoriesRouter({
  requireAuthenticatedUser,
}: CategoriesRouterDependencies): Router {
  const categoriesRouter = Router();

  categoriesRouter.use(requireAuthenticatedUser);

  categoriesRouter.get('/presets', (_req, res) => {
    res
      .status(200)
      .json({ data: { names: [...CATEGORY_PRESET_NAMES] } } satisfies CategoryPresetsResponseBody);
  });

  categoriesRouter.post('/', async (req, res) => {
    const newCategory = parseRequestBody(createCategoryRequestSchema, req.body);
    const category = await createCategory(ownerIdOf(req), newCategory);
    res
      .status(201)
      .location(`${req.baseUrl}/${category.id}`)
      .json({ data: category } satisfies CategoryResponseBody);
  });

  categoriesRouter.get('/', async (req, res) => {
    const listQuery = parseRequestQuery(listCategoriesQuerySchema, req.query);
    const { categories, pagination } = await listCategoriesOwnedByUser(ownerIdOf(req), listQuery);
    res
      .status(200)
      .json({ data: categories, meta: { pagination } } satisfies CategoryListResponseBody);
  });

  categoriesRouter.get('/:categoryId', async (req, res) => {
    const category = await findCategoryOwnedByUser(ownerIdOf(req), categoryIdOf(req));
    res.status(200).json({ data: category } satisfies CategoryResponseBody);
  });

  categoriesRouter.patch('/:categoryId', async (req, res) => {
    const categoryId = categoryIdOf(req);
    const changes = parseRequestBody(updateCategoryRequestSchema, req.body);
    const category = await updateCategoryOwnedByUser(ownerIdOf(req), categoryId, changes);
    res.status(200).json({ data: category } satisfies CategoryResponseBody);
  });

  categoriesRouter.delete('/:categoryId', async (req, res) => {
    await deleteCategoryOwnedByUser(ownerIdOf(req), categoryIdOf(req));
    res.status(204).end();
  });

  categoriesRouter.put('/:categoryId/books/:bookId', async (req, res) => {
    const { categoryId, bookId } = membershipOf(req);
    await addBookToCategory(ownerIdOf(req), categoryId, bookId);
    res.status(204).end();
  });

  categoriesRouter.delete('/:categoryId/books/:bookId', async (req, res) => {
    const { categoryId, bookId } = membershipOf(req);
    await removeBookFromCategory(ownerIdOf(req), categoryId, bookId);
    res.status(204).end();
  });

  categoriesRouter.get('/:categoryId/books', async (req, res) => {
    const categoryId = categoryIdOf(req);
    const pageQuery = parseRequestQuery(listCategoriesQuerySchema, req.query);
    const { books, pagination } = await listBooksInCategory(ownerIdOf(req), categoryId, pageQuery);
    res.status(200).json({ data: books, meta: { pagination } } satisfies BookListResponseBody);
  });

  return categoriesRouter;
}
