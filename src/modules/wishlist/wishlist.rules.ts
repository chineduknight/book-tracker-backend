import { toCaseInsensitiveKey } from '../../shared/text.js';
import type { WishlistPriority } from './wishlist.schema.js';

/** Sort key for priority ordering: the most urgent wish ranks first. */
const PRIORITY_RANKS = { high: 0, medium: 1, low: 2 } as const satisfies Record<
  WishlistPriority,
  number
>;

export function priorityRankOf(priority: WishlistPriority): number {
  return PRIORITY_RANKS[priority];
}

export function normalizeWishTitle(title: string): string {
  return toCaseInsensitiveKey(title);
}
