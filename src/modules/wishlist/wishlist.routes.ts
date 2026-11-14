import { Router, type Request, type RequestHandler } from 'express';
import {
  parseRequestBody,
  parseRequestQuery,
  parseRouteParams,
} from '../../shared/request-validation.js';
import { authenticatedUserOf } from '../auth/auth.middleware.js';
import type { WishlistItemListResponseBody, WishlistItemResponseBody } from './wishlist.dto.js';
import {
  acquireWishlistItemRequestSchema,
  createWishlistItemRequestSchema,
  listWishlistQuerySchema,
  updateWishlistItemRequestSchema,
  wishlistItemIdParamsSchema,
} from './wishlist.schema.js';
import {
  acquireWishlistItem,
  createWishlistItem,
  deleteWishlistItemOwnedByUser,
  findWishlistItemOwnedByUser,
  listWishlistItemsOwnedByUser,
  updateWishlistItemOwnedByUser,
} from './wishlist.service.js';

export interface WishlistRouterDependencies {
  requireAuthenticatedUser: RequestHandler;
}

function ownerIdOf(req: Request): string {
  return authenticatedUserOf(req).userId;
}

function wishlistItemIdOf(req: Request): string {
  return parseRouteParams(wishlistItemIdParamsSchema, req.params).wishlistItemId;
}

export function createWishlistRouter({
  requireAuthenticatedUser,
}: WishlistRouterDependencies): Router {
  const wishlistRouter = Router();

  wishlistRouter.use(requireAuthenticatedUser);

  wishlistRouter.post('/', async (req, res) => {
    const newItem = parseRequestBody(createWishlistItemRequestSchema, req.body);
    const item = await createWishlistItem(ownerIdOf(req), newItem);
    res
      .status(201)
      .location(`${req.baseUrl}/${item.id}`)
      .json({ data: item } satisfies WishlistItemResponseBody);
  });

  wishlistRouter.get('/', async (req, res) => {
    const listQuery = parseRequestQuery(listWishlistQuerySchema, req.query);
    const { items, pagination } = await listWishlistItemsOwnedByUser(ownerIdOf(req), listQuery);
    res
      .status(200)
      .json({ data: items, meta: { pagination } } satisfies WishlistItemListResponseBody);
  });

  wishlistRouter.get('/:wishlistItemId', async (req, res) => {
    const item = await findWishlistItemOwnedByUser(ownerIdOf(req), wishlistItemIdOf(req));
    res.status(200).json({ data: item } satisfies WishlistItemResponseBody);
  });

  wishlistRouter.patch('/:wishlistItemId', async (req, res) => {
    const wishlistItemId = wishlistItemIdOf(req);
    const changes = parseRequestBody(updateWishlistItemRequestSchema, req.body);
    const item = await updateWishlistItemOwnedByUser(ownerIdOf(req), wishlistItemId, changes);
    res.status(200).json({ data: item } satisfies WishlistItemResponseBody);
  });

  wishlistRouter.put('/:wishlistItemId/acquisition', async (req, res) => {
    const wishlistItemId = wishlistItemIdOf(req);
    const acquisition = parseRequestBody(acquireWishlistItemRequestSchema, req.body);
    const item = await acquireWishlistItem(ownerIdOf(req), wishlistItemId, acquisition);
    res.status(200).json({ data: item } satisfies WishlistItemResponseBody);
  });

  wishlistRouter.delete('/:wishlistItemId', async (req, res) => {
    await deleteWishlistItemOwnedByUser(ownerIdOf(req), wishlistItemIdOf(req));
    res.status(204).end();
  });

  return wishlistRouter;
}
