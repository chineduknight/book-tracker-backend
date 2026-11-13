import { z } from 'zod';
import {
  limitQueryParameter,
  objectIdQueryParameter,
  objectIdSchema,
  pageQueryParameter,
  singleQueryChoice,
  requiringAtLeastOneChange,
} from '../../shared/request-schemas.js';

export const PHYSICAL_COPY_CONDITIONS = ['new', 'like_new', 'good', 'fair', 'poor'] as const;

const label = z.string().trim().min(1).max(100);
const condition = z.enum(PHYSICAL_COPY_CONDITIONS);
const storageNote = z.string().trim().min(1).max(500);

export const createCopyRequestSchema = z
  .strictObject({
    locationId: objectIdSchema.nullable().optional(),
    label: label.optional(),
    condition: condition.optional(),
    storageNote: storageNote.optional(),
  })
  .default({});

export const updateCopyRequestSchema = requiringAtLeastOneChange(
  z.strictObject({
    locationId: objectIdSchema.nullable().optional(),
    label: label.nullable().optional(),
    condition: condition.nullable().optional(),
    storageNote: storageNote.nullable().optional(),
  }),
);

export const listCopiesQuerySchema = z.strictObject({
  page: pageQueryParameter,
  limit: limitQueryParameter,
  locationId: objectIdQueryParameter.optional(),
  condition: singleQueryChoice(PHYSICAL_COPY_CONDITIONS).optional(),
});

export const bookCopiesParamsSchema = z.strictObject({ bookId: objectIdSchema });
export const copyIdParamsSchema = z.strictObject({ copyId: objectIdSchema });

export type NewPhysicalCopy = z.output<typeof createCopyRequestSchema>;
export type PhysicalCopyChanges = z.output<typeof updateCopyRequestSchema>;
export type CopyListQuery = z.output<typeof listCopiesQuerySchema>;
