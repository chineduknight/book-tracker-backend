import { isDuplicateKeyError } from '../../db/mongo.js';
import { toPaginationMeta, type PaginationMeta } from '../../shared/api-response.js';
import { AppError } from '../../shared/errors.js';
import { toCaseInsensitiveKey } from '../../shared/text.js';
import { toPublicStorageLocation, type StorageLocationDto } from './location.dto.js';
import { LocationModel } from './location.model.js';
import type { LocationChanges, LocationListQuery, NewLocation } from './location.schema.js';

const ALPHABETICAL = { normalizedName: 1, _id: 1 } as const;

export interface StorageLocationPage {
  locations: StorageLocationDto[];
  pagination: PaginationMeta;
}

function locationNotFoundError(): AppError {
  return new AppError(404, 'NOT_FOUND', 'Location not found');
}

function locationNameTakenError(): AppError {
  return new AppError(409, 'CONFLICT', 'A location with this name already exists');
}

function locationOwnedBy(ownerId: string, locationId: string) {
  return { _id: locationId, ownerId };
}

async function rejectingDuplicateNames<Result>(write: () => Promise<Result>): Promise<Result> {
  try {
    return await write();
  } catch (error) {
    if (isDuplicateKeyError(error)) throw locationNameTakenError();
    throw error;
  }
}

function toLocationUpdate({ name, description }: LocationChanges) {
  return {
    $set: {
      ...(name !== undefined && { name, normalizedName: toCaseInsensitiveKey(name) }),
      ...(typeof description === 'string' && { description }),
    },
    $unset: { ...(description === null && { description: '' }) },
  };
}

export async function createLocation(
  ownerId: string,
  { name, description }: NewLocation,
): Promise<StorageLocationDto> {
  const location = await rejectingDuplicateNames(() =>
    new LocationModel({
      ownerId,
      name,
      normalizedName: toCaseInsensitiveKey(name),
      ...(description !== undefined && { description }),
    }).save(),
  );
  return toPublicStorageLocation(location.toObject());
}

export async function listLocationsOwnedByUser(
  ownerId: string,
  { page, limit }: LocationListQuery,
): Promise<StorageLocationPage> {
  const [locations, total] = await Promise.all([
    LocationModel.find({ ownerId })
      .sort(ALPHABETICAL)
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    LocationModel.countDocuments({ ownerId }),
  ]);
  return {
    locations: locations.map(toPublicStorageLocation),
    pagination: toPaginationMeta(page, limit, total),
  };
}

export async function findLocationOwnedByUser(
  ownerId: string,
  locationId: string,
): Promise<StorageLocationDto> {
  const location = await LocationModel.findOne(locationOwnedBy(ownerId, locationId)).lean();
  if (!location) throw locationNotFoundError();
  return toPublicStorageLocation(location);
}

export async function updateLocationOwnedByUser(
  ownerId: string,
  locationId: string,
  changes: LocationChanges,
): Promise<StorageLocationDto> {
  const location = await rejectingDuplicateNames(() =>
    LocationModel.findOneAndUpdate(
      locationOwnedBy(ownerId, locationId),
      toLocationUpdate(changes),
      {
        returnDocument: 'after',
        runValidators: true,
      },
    ).lean(),
  );
  if (!location) throw locationNotFoundError();
  return toPublicStorageLocation(location);
}

export async function requireLocationOwnedByUser(ownerId: string, locationId: string) {
  const location = await LocationModel.exists(locationOwnedBy(ownerId, locationId));
  if (!location) throw locationNotFoundError();
}
