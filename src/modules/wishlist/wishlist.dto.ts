import type { PaginatedResponseBody, SuccessResponseBody } from '../../shared/api-response.js';
import type { WishlistItemRecord } from './wishlist.model.js';

export type WishlistPriorityDto = 'low' | 'medium' | 'high';
export type WishlistStatusDto = 'wanted' | 'acquired';
export type WishlistPreferredFormatDto = 'physical' | 'ebook';

export interface WishlistItemDto {
  id: string;
  title: string;
  authors: string[];
  isbn?: string;
  preferredFormat?: WishlistPreferredFormatDto;
  coverUrl?: string;
  sourceUrl?: string;
  priority: WishlistPriorityDto;
  note?: string;
  status: WishlistStatusDto;
  acquiredBookId: string | null;
  acquiredAt?: string;
  createdAt: string;
  updatedAt: string;
}

export type WishlistItemResponseBody = SuccessResponseBody<WishlistItemDto>;
export type WishlistItemListResponseBody = PaginatedResponseBody<WishlistItemDto>;

export function toPublicWishlistItem(item: WishlistItemRecord): WishlistItemDto {
  return {
    id: item._id.toHexString(),
    title: item.title,
    authors: [...item.authors],
    ...(item.isbn != null && { isbn: item.isbn }),
    ...(item.preferredFormat != null && { preferredFormat: item.preferredFormat }),
    ...(item.coverUrl != null && { coverUrl: item.coverUrl }),
    ...(item.sourceUrl != null && { sourceUrl: item.sourceUrl }),
    priority: item.priority,
    ...(item.note != null && { note: item.note }),
    status: item.status,
    acquiredBookId: item.acquiredBookId?.toHexString() ?? null,
    ...(item.acquiredAt != null && { acquiredAt: item.acquiredAt.toISOString() }),
    createdAt: item.createdAt.toISOString(),
    updatedAt: item.updatedAt.toISOString(),
  };
}

export interface WishlistItemExportDto extends WishlistItemDto {
  deletedAt: string | null;
}

export function toArchivedWishlistItem(item: WishlistItemRecord): WishlistItemExportDto {
  return { ...toPublicWishlistItem(item), deletedAt: item.deletedAt?.toISOString() ?? null };
}
