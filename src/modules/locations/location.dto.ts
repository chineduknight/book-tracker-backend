import type { PaginatedResponseBody, SuccessResponseBody } from '../../shared/api-response.js';
import type { LocationRecord } from './location.model.js';

export interface StorageLocationDto {
  id: string;
  name: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
}

export type StorageLocationResponseBody = SuccessResponseBody<StorageLocationDto>;
export type StorageLocationListResponseBody = PaginatedResponseBody<StorageLocationDto>;

export function toPublicStorageLocation(location: LocationRecord): StorageLocationDto {
  return {
    id: location._id.toHexString(),
    name: location.name,
    ...(location.description != null && { description: location.description }),
    createdAt: location.createdAt.toISOString(),
    updatedAt: location.updatedAt.toISOString(),
  };
}
