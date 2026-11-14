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

export const createCollectionRequestSchema = z.strictObject({
  name,
  description: description.optional(),
});

export const updateCollectionRequestSchema = requiringAtLeastOneChange(
  z.strictObject({
    name: name.optional(),
    description: description.nullable().optional(),
  }),
);

export const listCollectionsQuerySchema = z.strictObject({
  page: pageQueryParameter,
  limit: limitQueryParameter,
});

export const collectionIdParamsSchema = z.strictObject({ collectionId: objectIdSchema });
export const collectionBookParamsSchema = z.strictObject({
  collectionId: objectIdSchema,
  bookId: objectIdSchema,
});

export type NewCollection = z.output<typeof createCollectionRequestSchema>;
export type CollectionChanges = z.output<typeof updateCollectionRequestSchema>;
export type CollectionListQuery = z.output<typeof listCollectionsQuerySchema>;
