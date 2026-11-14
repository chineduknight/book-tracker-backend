import type { SuccessResponseBody } from '../../shared/api-response.js';
import type { CategoryDto } from '../categories/category.dto.js';
import type { BookCollectionDto } from '../collections/collection.dto.js';

/** The reader's active categories and collections that contain one book. */
export interface BookOrganizationDto {
  bookId: string;
  categories: CategoryDto[];
  collections: BookCollectionDto[];
}

export type BookOrganizationResponseBody = SuccessResponseBody<BookOrganizationDto>;
