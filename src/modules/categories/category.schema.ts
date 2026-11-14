import { z } from 'zod';
import {
  limitQueryParameter,
  objectIdSchema,
  pageQueryParameter,
  requiringAtLeastOneChange,
} from '../../shared/request-schemas.js';
import { collapseWhitespace } from '../../shared/text.js';

const name = z.string().transform(collapseWhitespace).pipe(z.string().min(1).max(100));
const description = z.string().trim().min(1).max(500);

export const createCategoryRequestSchema = z.strictObject({
  name,
  description: description.optional(),
});

export const updateCategoryRequestSchema = requiringAtLeastOneChange(
  z.strictObject({
    name: name.optional(),
    description: description.nullable().optional(),
  }),
);

export const listCategoriesQuerySchema = z.strictObject({
  page: pageQueryParameter,
  limit: limitQueryParameter,
});

export const categoryIdParamsSchema = z.strictObject({ categoryId: objectIdSchema });
export const categoryBookParamsSchema = z.strictObject({
  categoryId: objectIdSchema,
  bookId: objectIdSchema,
});

export type NewCategory = z.output<typeof createCategoryRequestSchema>;
export type CategoryChanges = z.output<typeof updateCategoryRequestSchema>;
export type CategoryListQuery = z.output<typeof listCategoriesQuerySchema>;
