import type { PaginatedResponseBody, SuccessResponseBody } from '../../shared/api-response.js';
import type { PhysicalCopyRecord } from './copy.model.js';

export type PhysicalCopyCondition = 'new' | 'like_new' | 'good' | 'fair' | 'poor';

export interface PhysicalCopyDto {
  id: string;
  bookId: string;
  locationId: string | null;
  label?: string;
  condition?: PhysicalCopyCondition;
  storageNote?: string;
  createdAt: string;
  updatedAt: string;
}

export type PhysicalCopyResponseBody = SuccessResponseBody<PhysicalCopyDto>;
export type PhysicalCopyListResponseBody = PaginatedResponseBody<PhysicalCopyDto>;

export function toPublicPhysicalCopy(copy: PhysicalCopyRecord): PhysicalCopyDto {
  return {
    id: copy._id.toHexString(),
    bookId: copy.bookId.toHexString(),
    locationId: copy.locationId?.toHexString() ?? null,
    ...(copy.label != null && { label: copy.label }),
    ...(copy.condition != null && { condition: copy.condition }),
    ...(copy.storageNote != null && { storageNote: copy.storageNote }),
    createdAt: copy.createdAt.toISOString(),
    updatedAt: copy.updatedAt.toISOString(),
  };
}

export interface PhysicalCopyExportDto extends PhysicalCopyDto {
  deletedAt: string | null;
}

export function toArchivedPhysicalCopy(copy: PhysicalCopyRecord): PhysicalCopyExportDto {
  return { ...toPublicPhysicalCopy(copy), deletedAt: copy.deletedAt?.toISOString() ?? null };
}
