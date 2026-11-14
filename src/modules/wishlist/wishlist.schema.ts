import { z } from 'zod';
import {
  limitQueryParameter,
  objectIdSchema,
  pageQueryParameter,
  requiringAtLeastOneChange,
  singleQueryChoice,
  textSearchQueryParameter,
} from '../../shared/request-schemas.js';
import { collapseWhitespace, containsLetterOrDigit } from '../../shared/text.js';

export const WISHLIST_PRIORITIES = ['low', 'medium', 'high'] as const;
export const WISHLIST_STATUSES = ['wanted', 'acquired'] as const;
export const WISHLIST_PREFERRED_FORMATS = ['physical', 'ebook'] as const;
const WISHLIST_STATUS_FILTERS = ['wanted', 'acquired', 'all'] as const;
const WISHLIST_SORT_ORDERS = ['recent', 'oldest', 'title_asc', 'title_desc', 'priority'] as const;

const title = z.string().transform(collapseWhitespace).pipe(z.string().min(1).max(250));
const author = z.string().trim().min(1).max(120);
const authors = z.array(author).max(20);
const isbn = z
  .string()
  .trim()
  .max(32)
  .refine(containsLetterOrDigit, 'must contain at least one letter or digit');
const preferredFormat = z.enum(WISHLIST_PREFERRED_FORMATS);
const externalUrl = z
  .string()
  .trim()
  .max(2_048)
  .pipe(z.url({ protocol: /^https?$/, error: 'must be an absolute http or https URL' }));
const priority = z.enum(WISHLIST_PRIORITIES);
const note = z.string().trim().min(1).max(2_000);

export const createWishlistItemRequestSchema = z.strictObject({
  title,
  authors: authors.default([]),
  isbn: isbn.optional(),
  preferredFormat: preferredFormat.optional(),
  coverUrl: externalUrl.optional(),
  sourceUrl: externalUrl.optional(),
  priority: priority.default('medium'),
  note: note.optional(),
});

export const updateWishlistItemRequestSchema = requiringAtLeastOneChange(
  z.strictObject({
    title: title.optional(),
    authors: authors.optional(),
    isbn: isbn.nullable().optional(),
    preferredFormat: preferredFormat.nullable().optional(),
    coverUrl: externalUrl.nullable().optional(),
    sourceUrl: externalUrl.nullable().optional(),
    priority: priority.optional(),
    note: note.nullable().optional(),
  }),
);

export const acquireWishlistItemRequestSchema = z.strictObject({ bookId: objectIdSchema });

export const listWishlistQuerySchema = z.strictObject({
  page: pageQueryParameter,
  limit: limitQueryParameter,
  status: singleQueryChoice(WISHLIST_STATUS_FILTERS).default('wanted'),
  priority: singleQueryChoice(WISHLIST_PRIORITIES).optional(),
  q: textSearchQueryParameter.optional(),
  sort: singleQueryChoice(WISHLIST_SORT_ORDERS).default('recent'),
});

export const wishlistItemIdParamsSchema = z.strictObject({ wishlistItemId: objectIdSchema });

export type WishlistPriority = (typeof WISHLIST_PRIORITIES)[number];
export type WishlistStatus = (typeof WISHLIST_STATUSES)[number];
export type WishlistSortOrder = (typeof WISHLIST_SORT_ORDERS)[number];
export type NewWishlistItem = z.output<typeof createWishlistItemRequestSchema>;
export type WishlistItemChanges = z.output<typeof updateWishlistItemRequestSchema>;
export type WishlistAcquisition = z.output<typeof acquireWishlistItemRequestSchema>;
export type WishlistQuery = z.output<typeof listWishlistQuerySchema>;
