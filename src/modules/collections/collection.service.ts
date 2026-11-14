import { isDuplicateKeyError } from '../../db/mongo.js';
import { toPaginationMeta, type PaginationMeta } from '../../shared/api-response.js';
import { ARCHIVE_ORDER } from '../../shared/archive-order.js';
import { AppError } from '../../shared/errors.js';
import { toCaseInsensitiveKey } from '../../shared/text.js';
import {
  listActiveBooksInMembershipOrder,
  requireActiveBookOwnedByUser,
  type BookPage,
} from '../books/book.service.js';
import {
  toArchivedBookCollection,
  toPublicBookCollection,
  type BookCollectionDto,
  type BookCollectionExportDto,
} from './collection.dto.js';
import { BookCollectionModel } from './collection.model.js';
import type { CollectionChanges, CollectionListQuery, NewCollection } from './collection.schema.js';

const ALPHABETICAL = { normalizedName: 1, _id: 1 } as const;

export interface CollectionPage {
  collections: BookCollectionDto[];
  pagination: PaginationMeta;
}

function collectionNotFoundError(): AppError {
  return new AppError(404, 'NOT_FOUND', 'Collection not found');
}

function collectionNameTakenError(): AppError {
  return new AppError(409, 'CONFLICT', 'A collection with this name already exists');
}

function activeCollectionsOwnedBy(ownerId: string) {
  return { ownerId, deletedAt: null };
}

function activeCollectionOwnedBy(ownerId: string, collectionId: string) {
  return { ...activeCollectionsOwnedBy(ownerId), _id: collectionId };
}

async function rejectingDuplicateNames<Result>(write: () => Promise<Result>): Promise<Result> {
  try {
    return await write();
  } catch (error) {
    if (isDuplicateKeyError(error)) throw collectionNameTakenError();
    throw error;
  }
}

function toCollectionUpdate({ name, description }: CollectionChanges) {
  return {
    $set: {
      ...(name !== undefined && { name, normalizedName: toCaseInsensitiveKey(name) }),
      ...(typeof description === 'string' && { description }),
    },
    $unset: { ...(description === null && { description: '' }) },
  };
}

export async function createCollection(
  ownerId: string,
  { name, description }: NewCollection,
): Promise<BookCollectionDto> {
  const collection = await rejectingDuplicateNames(() =>
    new BookCollectionModel({
      ownerId,
      name,
      normalizedName: toCaseInsensitiveKey(name),
      ...(description !== undefined && { description }),
    }).save(),
  );
  return toPublicBookCollection(collection.toObject());
}

export async function listCollectionsOwnedByUser(
  ownerId: string,
  { page, limit }: CollectionListQuery,
): Promise<CollectionPage> {
  const filter = activeCollectionsOwnedBy(ownerId);
  const [collections, total] = await Promise.all([
    BookCollectionModel.find(filter)
      .sort(ALPHABETICAL)
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    BookCollectionModel.countDocuments(filter),
  ]);
  return {
    collections: collections.map(toPublicBookCollection),
    pagination: toPaginationMeta(page, limit, total),
  };
}

export async function findCollectionOwnedByUser(
  ownerId: string,
  collectionId: string,
): Promise<BookCollectionDto> {
  const collection = await BookCollectionModel.findOne(
    activeCollectionOwnedBy(ownerId, collectionId),
  ).lean();
  if (!collection) throw collectionNotFoundError();
  return toPublicBookCollection(collection);
}

export async function updateCollectionOwnedByUser(
  ownerId: string,
  collectionId: string,
  changes: CollectionChanges,
): Promise<BookCollectionDto> {
  const collection = await rejectingDuplicateNames(() =>
    BookCollectionModel.findOneAndUpdate(
      activeCollectionOwnedBy(ownerId, collectionId),
      toCollectionUpdate(changes),
      { returnDocument: 'after', runValidators: true },
    ).lean(),
  );
  if (!collection) throw collectionNotFoundError();
  return toPublicBookCollection(collection);
}

export async function deleteCollectionOwnedByUser(ownerId: string, collectionId: string) {
  const { matchedCount } = await BookCollectionModel.updateOne(
    activeCollectionOwnedBy(ownerId, collectionId),
    { $set: { deletedAt: new Date() } },
  );
  if (matchedCount === 0) throw collectionNotFoundError();
}

/*
 * Membership writes are single atomic updates on the active, owned collection, so concurrent adds
 * and removals never overwrite each other and a deleted collection is never written to.
 */
export async function addBookToCollection(ownerId: string, collectionId: string, bookId: string) {
  await requireActiveBookOwnedByUser(ownerId, bookId);
  const { matchedCount } = await BookCollectionModel.updateOne(
    activeCollectionOwnedBy(ownerId, collectionId),
    { $addToSet: { bookIds: bookId } },
  );
  if (matchedCount === 0) throw collectionNotFoundError();
}

export async function removeBookFromCollection(
  ownerId: string,
  collectionId: string,
  bookId: string,
) {
  await requireActiveBookOwnedByUser(ownerId, bookId);
  const { matchedCount } = await BookCollectionModel.updateOne(
    activeCollectionOwnedBy(ownerId, collectionId),
    { $pull: { bookIds: bookId } },
  );
  if (matchedCount === 0) throw collectionNotFoundError();
}

export async function listBooksInCollection(
  ownerId: string,
  collectionId: string,
  pageQuery: CollectionListQuery,
): Promise<BookPage> {
  const collection = await BookCollectionModel.findOne(
    activeCollectionOwnedBy(ownerId, collectionId),
  )
    .select({ bookIds: 1 })
    .lean();
  if (!collection) throw collectionNotFoundError();
  return listActiveBooksInMembershipOrder(ownerId, collection.bookIds, pageQuery);
}

/** Active collections of the owner that contain the book, alphabetically. Callers check the book. */
export async function findCollectionsContainingBook(
  ownerId: string,
  bookId: string,
): Promise<BookCollectionDto[]> {
  const collections = await BookCollectionModel.find({
    ...activeCollectionsOwnedBy(ownerId),
    bookIds: bookId,
  })
    .sort(ALPHABETICAL)
    .lean();
  return collections.map(toPublicBookCollection);
}

/** Every collection of the owner, deleted ones included, oldest first, for the data export. */
export async function* streamCollectionsForArchive(
  ownerId: string,
): AsyncGenerator<BookCollectionExportDto> {
  const collections = BookCollectionModel.find({ ownerId }).sort(ARCHIVE_ORDER).lean().cursor();
  for await (const collection of collections) {
    yield toArchivedBookCollection(collection);
  }
}
