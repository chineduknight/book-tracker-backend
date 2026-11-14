import { requireActiveBookOwnedByUser } from '../books/book.service.js';
import { findCategoriesContainingBook } from '../categories/category.service.js';
import { findCollectionsContainingBook } from '../collections/collection.service.js';
import type { BookOrganizationDto } from './organization.dto.js';

export async function findBookOrganization(
  ownerId: string,
  bookId: string,
): Promise<BookOrganizationDto> {
  await requireActiveBookOwnedByUser(ownerId, bookId);
  const [categories, collections] = await Promise.all([
    findCategoriesContainingBook(ownerId, bookId),
    findCollectionsContainingBook(ownerId, bookId),
  ]);
  return { bookId, categories, collections };
}
