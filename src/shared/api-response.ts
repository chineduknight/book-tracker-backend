export type { ErrorResponseBody } from './errors.js';

export interface SuccessResponseBody<Resource> {
  data: Resource;
}

export interface PaginationMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface PaginatedResponseBody<Item> {
  data: Item[];
  meta: { pagination: PaginationMeta };
}

export function toPaginationMeta(page: number, limit: number, total: number): PaginationMeta {
  return { page, limit, total, totalPages: Math.ceil(total / limit) };
}
