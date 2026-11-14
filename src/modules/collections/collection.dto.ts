import type { PaginatedResponseBody, SuccessResponseBody } from '../../shared/api-response.js';
import type { BookCollectionRecord } from './collection.model.js';

export interface BookCollectionDto {
  id: string;
  name: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
}

export type BookCollectionResponseBody = SuccessResponseBody<BookCollectionDto>;
export type BookCollectionListResponseBody = PaginatedResponseBody<BookCollectionDto>;

export function toPublicBookCollection(collection: BookCollectionRecord): BookCollectionDto {
  return {
    id: collection._id.toHexString(),
    name: collection.name,
    ...(collection.description != null && { description: collection.description }),
    createdAt: collection.createdAt.toISOString(),
    updatedAt: collection.updatedAt.toISOString(),
  };
}

/** A collection in the archive, with its member book ids in membership order. */
export interface BookCollectionExportDto extends BookCollectionDto {
  bookIds: string[];
  deletedAt: string | null;
}

export function toArchivedBookCollection(
  collection: BookCollectionRecord,
): BookCollectionExportDto {
  return {
    ...toPublicBookCollection(collection),
    bookIds: collection.bookIds.map((bookId) => bookId.toHexString()),
    deletedAt: collection.deletedAt?.toISOString() ?? null,
  };
}
