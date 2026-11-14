import mongoose from 'mongoose';
import { toPaginationMeta, type PaginationMeta } from '../../shared/api-response.js';
import { ARCHIVE_ORDER } from '../../shared/archive-order.js';
import { AppError } from '../../shared/errors.js';
import { toTextSearchWords } from '../../shared/text.js';
import { requireActiveBookOwnedByUser } from '../books/book.service.js';
import {
  toArchivedWishlistItem,
  toPublicWishlistItem,
  type WishlistItemDto,
  type WishlistItemExportDto,
} from './wishlist.dto.js';
import { WishlistItemModel, type WishlistItemRecord } from './wishlist.model.js';
import { normalizeWishTitle, priorityRankOf } from './wishlist.rules.js';
import type {
  NewWishlistItem,
  WishlistAcquisition,
  WishlistItemChanges,
  WishlistQuery,
  WishlistSortOrder,
} from './wishlist.schema.js';

const SORT_ORDERS = {
  recent: { createdAt: -1, _id: -1 },
  oldest: { createdAt: 1, _id: 1 },
  title_asc: { normalizedTitle: 1, _id: 1 },
  title_desc: { normalizedTitle: -1, _id: -1 },
  priority: { priorityRank: 1, createdAt: -1, _id: -1 },
} as const satisfies Record<WishlistSortOrder, Record<string, 1 | -1>>;

export interface WishlistPage {
  items: WishlistItemDto[];
  pagination: PaginationMeta;
}

function wishlistItemNotFoundError(): AppError {
  return new AppError(404, 'NOT_FOUND', 'Wishlist item not found');
}

function wishlistItemAlreadyAcquiredError(): AppError {
  return new AppError(
    409,
    'WISHLIST_ALREADY_ACQUIRED',
    'This wishlist item was already acquired with a different book',
  );
}

function activeItemsOwnedBy(ownerId: string) {
  return { ownerId, deletedAt: null };
}

function activeItemOwnedBy(ownerId: string, wishlistItemId: string) {
  return { ...activeItemsOwnedBy(ownerId), _id: wishlistItemId };
}

function isAcquiredWith(item: WishlistItemRecord, bookId: string): boolean {
  return item.acquiredBookId?.equals(new mongoose.Types.ObjectId(bookId)) ?? false;
}

function toWishlistItemUpdate(changes: WishlistItemChanges) {
  const fieldsToSet: Record<string, unknown> = {};
  const fieldsToClear: Record<string, ''> = {};

  for (const [field, value] of Object.entries(changes)) {
    if (value === null) fieldsToClear[field] = '';
    else fieldsToSet[field] = value;
  }
  if (changes.title !== undefined) fieldsToSet.normalizedTitle = normalizeWishTitle(changes.title);
  if (changes.priority !== undefined) fieldsToSet.priorityRank = priorityRankOf(changes.priority);

  return { $set: fieldsToSet, $unset: fieldsToClear };
}

export async function createWishlistItem(
  ownerId: string,
  newItem: NewWishlistItem,
): Promise<WishlistItemDto> {
  const item = await new WishlistItemModel({
    ...newItem,
    ownerId,
    normalizedTitle: normalizeWishTitle(newItem.title),
    priorityRank: priorityRankOf(newItem.priority),
  }).save();
  return toPublicWishlistItem(item.toObject());
}

export async function listWishlistItemsOwnedByUser(
  ownerId: string,
  { page, limit, status, priority, q, sort }: WishlistQuery,
): Promise<WishlistPage> {
  const filter = {
    ...activeItemsOwnedBy(ownerId),
    ...(status !== 'all' && { status }),
    ...(priority !== undefined && { priority }),
    ...(q !== undefined && { $text: { $search: toTextSearchWords(q) } }),
  };

  const [items, total] = await Promise.all([
    WishlistItemModel.find(filter)
      .sort(SORT_ORDERS[sort])
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    WishlistItemModel.countDocuments(filter),
  ]);

  return {
    items: items.map(toPublicWishlistItem),
    pagination: toPaginationMeta(page, limit, total),
  };
}

export async function findWishlistItemOwnedByUser(
  ownerId: string,
  wishlistItemId: string,
): Promise<WishlistItemDto> {
  const item = await WishlistItemModel.findOne(activeItemOwnedBy(ownerId, wishlistItemId)).lean();
  if (!item) throw wishlistItemNotFoundError();
  return toPublicWishlistItem(item);
}

export async function updateWishlistItemOwnedByUser(
  ownerId: string,
  wishlistItemId: string,
  changes: WishlistItemChanges,
): Promise<WishlistItemDto> {
  const item = await WishlistItemModel.findOneAndUpdate(
    activeItemOwnedBy(ownerId, wishlistItemId),
    toWishlistItemUpdate(changes),
    { returnDocument: 'after', runValidators: true },
  ).lean();
  if (!item) throw wishlistItemNotFoundError();
  return toPublicWishlistItem(item);
}

/*
 * The transition from wanted to acquired is one conditional write that only matches a wanted
 * item, so concurrent acquisitions can produce exactly one link. A request whose write misses
 * re-reads the item: repeating the winning book is idempotent and writes nothing, a different
 * book is a conflict, and a missing or deleted item is reported as not found.
 */
export async function acquireWishlistItem(
  ownerId: string,
  wishlistItemId: string,
  { bookId }: WishlistAcquisition,
): Promise<WishlistItemDto> {
  await requireActiveBookOwnedByUser(ownerId, bookId);

  const acquiredItem = await WishlistItemModel.findOneAndUpdate(
    { ...activeItemOwnedBy(ownerId, wishlistItemId), status: 'wanted' },
    { $set: { status: 'acquired', acquiredBookId: bookId, acquiredAt: new Date() } },
    { returnDocument: 'after' },
  ).lean();
  if (acquiredItem) return toPublicWishlistItem(acquiredItem);

  const item = await WishlistItemModel.findOne(activeItemOwnedBy(ownerId, wishlistItemId)).lean();
  if (!item) throw wishlistItemNotFoundError();
  if (!isAcquiredWith(item, bookId)) throw wishlistItemAlreadyAcquiredError();
  return toPublicWishlistItem(item);
}

export async function deleteWishlistItemOwnedByUser(
  ownerId: string,
  wishlistItemId: string,
): Promise<void> {
  const { matchedCount } = await WishlistItemModel.updateOne(
    activeItemOwnedBy(ownerId, wishlistItemId),
    { $set: { deletedAt: new Date() } },
  );
  if (matchedCount === 0) throw wishlistItemNotFoundError();
}

export interface WishlistCounts {
  wanted: number;
  acquired: number;
}

/** Non-deleted wishes by status; an acquired wish counts even if its book was later deleted. */
export async function countWishlistItemsByStatus(ownerId: string): Promise<WishlistCounts> {
  const [wanted, acquired] = await Promise.all(
    (['wanted', 'acquired'] as const).map((status) =>
      WishlistItemModel.countDocuments({ ...activeItemsOwnedBy(ownerId), status }),
    ),
  );
  return { wanted: wanted ?? 0, acquired: acquired ?? 0 };
}

export interface RecentlyAddedWishlistItem {
  wishlistItemId: string;
  createdAt: Date;
}

export async function listRecentlyAddedWishlistItems(
  ownerId: string,
  limit: number,
): Promise<RecentlyAddedWishlistItem[]> {
  const items = await WishlistItemModel.find(activeItemsOwnedBy(ownerId))
    .sort(SORT_ORDERS.recent)
    .limit(limit)
    .select({ createdAt: 1 })
    .lean();
  return items.map((item) => ({
    wishlistItemId: item._id.toHexString(),
    createdAt: item.createdAt,
  }));
}

/** Every wish of the owner, deleted ones included, oldest first, for the data export. */
export async function* streamWishlistItemsForArchive(
  ownerId: string,
): AsyncGenerator<WishlistItemExportDto> {
  for await (const item of WishlistItemModel.find({ ownerId })
    .sort(ARCHIVE_ORDER)
    .lean()
    .cursor()) {
    yield toArchivedWishlistItem(item);
  }
}
