import { Router, type Request, type RequestHandler } from 'express';
import {
  parseRequestBody,
  parseRequestQuery,
  parseRouteParams,
} from '../../shared/request-validation.js';
import { authenticatedUserOf } from '../auth/auth.middleware.js';
import type {
  StorageLocationListResponseBody,
  StorageLocationResponseBody,
} from './location.dto.js';
import {
  createLocationRequestSchema,
  listLocationsQuerySchema,
  locationIdParamsSchema,
  updateLocationRequestSchema,
} from './location.schema.js';
import {
  createLocation,
  findLocationOwnedByUser,
  listLocationsOwnedByUser,
  updateLocationOwnedByUser,
} from './location.service.js';

export interface LocationsRouterDependencies {
  requireAuthenticatedUser: RequestHandler;
}

function ownerIdOf(req: Request): string {
  return authenticatedUserOf(req).userId;
}

function locationIdOf(req: Request): string {
  return parseRouteParams(locationIdParamsSchema, req.params).locationId;
}

export function createLocationsRouter({
  requireAuthenticatedUser,
}: LocationsRouterDependencies): Router {
  const locationsRouter = Router();

  locationsRouter.use(requireAuthenticatedUser);

  locationsRouter.post('/', async (req, res) => {
    const newLocation = parseRequestBody(createLocationRequestSchema, req.body);
    const location = await createLocation(ownerIdOf(req), newLocation);
    res
      .status(201)
      .location(`${req.baseUrl}/${location.id}`)
      .json({ data: location } satisfies StorageLocationResponseBody);
  });

  locationsRouter.get('/', async (req, res) => {
    const listQuery = parseRequestQuery(listLocationsQuerySchema, req.query);
    const { locations, pagination } = await listLocationsOwnedByUser(ownerIdOf(req), listQuery);
    res
      .status(200)
      .json({ data: locations, meta: { pagination } } satisfies StorageLocationListResponseBody);
  });

  locationsRouter.get('/:locationId', async (req, res) => {
    const location = await findLocationOwnedByUser(ownerIdOf(req), locationIdOf(req));
    res.status(200).json({ data: location } satisfies StorageLocationResponseBody);
  });

  locationsRouter.patch('/:locationId', async (req, res) => {
    const locationId = locationIdOf(req);
    const changes = parseRequestBody(updateLocationRequestSchema, req.body);
    const location = await updateLocationOwnedByUser(ownerIdOf(req), locationId, changes);
    res.status(200).json({ data: location } satisfies StorageLocationResponseBody);
  });

  return locationsRouter;
}
