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

export const createLocationRequestSchema = z.strictObject({
  name,
  description: description.optional(),
});

export const updateLocationRequestSchema = requiringAtLeastOneChange(
  z.strictObject({
    name: name.optional(),
    description: description.nullable().optional(),
  }),
);

export const listLocationsQuerySchema = z.strictObject({
  page: pageQueryParameter,
  limit: limitQueryParameter,
});

export const locationIdParamsSchema = z.strictObject({ locationId: objectIdSchema });

export type NewLocation = z.output<typeof createLocationRequestSchema>;
export type LocationChanges = z.output<typeof updateLocationRequestSchema>;
export type LocationListQuery = z.output<typeof listLocationsQuerySchema>;
