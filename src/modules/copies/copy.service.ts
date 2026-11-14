import { toPaginationMeta, type PaginationMeta } from '../../shared/api-response.js';
import { AppError } from '../../shared/errors.js';
import {
  isActiveBookOwnedByUser,
  requireActiveBookOwnedByUser,
  reserveBookForPhysicalCopy,
} from '../books/book.service.js';
import { requireLocationOwnedByUser } from '../locations/location.service.js';
import { toPublicPhysicalCopy, type PhysicalCopyDto } from './copy.dto.js';
import { PhysicalCopyModel, type PhysicalCopyRecord } from './copy.model.js';
import type { CopyListQuery, NewPhysicalCopy, PhysicalCopyChanges } from './copy.schema.js';

const NEWEST_FIRST = { createdAt: -1, _id: -1 } as const;
const CLEARABLE_FIELDS = ['label', 'condition', 'storageNote'] as const;

export interface PhysicalCopyPage {
  copies: PhysicalCopyDto[];
  pagination: PaginationMeta;
}

function copyNotFoundError(): AppError {
  return new AppError(404, 'NOT_FOUND', 'Copy not found');
}

function activeCopyOwnedBy(ownerId: string, copyId: string) {
  return { _id: copyId, ownerId, deletedAt: null };
}

async function findVisibleCopy(ownerId: string, copyId: string): Promise<PhysicalCopyRecord> {
  const copy = await PhysicalCopyModel.findOne(activeCopyOwnedBy(ownerId, copyId)).lean();
  if (!copy) throw copyNotFoundError();
  if (!(await isActiveBookOwnedByUser(ownerId, copy.bookId.toHexString()))) {
    throw copyNotFoundError();
  }
  return copy;
}

function toCopyUpdate(changes: PhysicalCopyChanges) {
  const fieldsToSet: Record<string, unknown> = {};
  const fieldsToClear: Record<string, ''> = {};

  if (changes.locationId !== undefined) fieldsToSet.locationId = changes.locationId;
  for (const field of CLEARABLE_FIELDS) {
    const value = changes[field];
    if (value === null) fieldsToClear[field] = '';
    else if (value !== undefined) fieldsToSet[field] = value;
  }

  return { $set: fieldsToSet, $unset: fieldsToClear };
}

export async function createPhysicalCopy(
  ownerId: string,
  bookId: string,
  newCopy: NewPhysicalCopy,
): Promise<PhysicalCopyDto> {
  if (typeof newCopy.locationId === 'string') {
    await requireLocationOwnedByUser(ownerId, newCopy.locationId);
  }
  await reserveBookForPhysicalCopy(ownerId, bookId);

  const copy = await new PhysicalCopyModel({ ...newCopy, ownerId, bookId }).save();
  return toPublicPhysicalCopy(copy.toObject());
}

export async function listCopiesOfBook(
  ownerId: string,
  bookId: string,
  { page, limit, locationId, condition }: CopyListQuery,
): Promise<PhysicalCopyPage> {
  await requireActiveBookOwnedByUser(ownerId, bookId);
  if (locationId !== undefined) await requireLocationOwnedByUser(ownerId, locationId);

  const filter = {
    ownerId,
    bookId,
    deletedAt: null,
    ...(locationId !== undefined && { locationId }),
    ...(condition !== undefined && { condition }),
  };
  const [copies, total] = await Promise.all([
    PhysicalCopyModel.find(filter)
      .sort(NEWEST_FIRST)
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    PhysicalCopyModel.countDocuments(filter),
  ]);

  return {
    copies: copies.map(toPublicPhysicalCopy),
    pagination: toPaginationMeta(page, limit, total),
  };
}

/** Book id of a visible copy of the owner, for modules that attach records to copies. */
export async function requireVisibleCopyBookIdOwnedByUser(
  ownerId: string,
  copyId: string,
): Promise<string> {
  const copy = await findVisibleCopy(ownerId, copyId);
  return copy.bookId.toHexString();
}

export async function findCopyOwnedByUser(
  ownerId: string,
  copyId: string,
): Promise<PhysicalCopyDto> {
  return toPublicPhysicalCopy(await findVisibleCopy(ownerId, copyId));
}

export async function updateCopyOwnedByUser(
  ownerId: string,
  copyId: string,
  changes: PhysicalCopyChanges,
): Promise<PhysicalCopyDto> {
  await findVisibleCopy(ownerId, copyId);
  if (typeof changes.locationId === 'string') {
    await requireLocationOwnedByUser(ownerId, changes.locationId);
  }

  const copy = await PhysicalCopyModel.findOneAndUpdate(
    activeCopyOwnedBy(ownerId, copyId),
    toCopyUpdate(changes),
    { returnDocument: 'after', runValidators: true },
  ).lean();
  if (!copy) throw copyNotFoundError();
  return toPublicPhysicalCopy(copy);
}

export async function deleteCopyOwnedByUser(ownerId: string, copyId: string): Promise<void> {
  await findVisibleCopy(ownerId, copyId);
  const { matchedCount } = await PhysicalCopyModel.updateOne(activeCopyOwnedBy(ownerId, copyId), {
    $set: { deletedAt: new Date() },
  });
  if (matchedCount === 0) throw copyNotFoundError();
}
