import type { PaginatedResponseBody, SuccessResponseBody } from '../../shared/api-response.js';
import type { CategoryRecord } from './category.model.js';

export interface CategoryDto {
  id: string;
  name: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
}

export type CategoryResponseBody = SuccessResponseBody<CategoryDto>;
export type CategoryListResponseBody = PaginatedResponseBody<CategoryDto>;
export type CategoryPresetsResponseBody = SuccessResponseBody<{ names: string[] }>;

export function toPublicCategory(category: CategoryRecord): CategoryDto {
  return {
    id: category._id.toHexString(),
    name: category.name,
    ...(category.description != null && { description: category.description }),
    createdAt: category.createdAt.toISOString(),
    updatedAt: category.updatedAt.toISOString(),
  };
}

/** A category in the archive, with its member book ids in membership order. */
export interface CategoryExportDto extends CategoryDto {
  bookIds: string[];
  deletedAt: string | null;
}

export function toArchivedCategory(category: CategoryRecord): CategoryExportDto {
  return {
    ...toPublicCategory(category),
    bookIds: category.bookIds.map((bookId) => bookId.toHexString()),
    deletedAt: category.deletedAt?.toISOString() ?? null,
  };
}
