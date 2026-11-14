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
