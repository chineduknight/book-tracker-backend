import type { Types } from 'mongoose';

interface Identified {
  _id: Types.ObjectId;
}

/**
 * The members that are still visible books, in membership order. Members whose book is missing,
 * deleted or not in `visibleBooks` are left out before any paging, so pages have no gaps.
 */
export function visibleMembersInOrder<Book extends Identified>(
  memberIds: readonly Types.ObjectId[],
  visibleBooks: readonly Book[],
): Book[] {
  const booksById = new Map(visibleBooks.map((book) => [book._id.toHexString(), book]));
  return memberIds.flatMap((memberId) => booksById.get(memberId.toHexString()) ?? []);
}

export function pageOf<Item>(items: readonly Item[], page: number, limit: number): Item[] {
  const start = (page - 1) * limit;
  return items.slice(start, start + limit);
}
