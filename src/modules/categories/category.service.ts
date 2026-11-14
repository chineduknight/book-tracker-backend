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
  toArchivedCategory,
  toPublicCategory,
  type CategoryDto,
  type CategoryExportDto,
} from './category.dto.js';
import { CategoryModel } from './category.model.js';
import type { CategoryChanges, CategoryListQuery, NewCategory } from './category.schema.js';

const ALPHABETICAL = { normalizedName: 1, _id: 1 } as const;

export interface CategoryPage {
  categories: CategoryDto[];
  pagination: PaginationMeta;
}

function categoryNotFoundError(): AppError {
  return new AppError(404, 'NOT_FOUND', 'Category not found');
}

function categoryNameTakenError(): AppError {
  return new AppError(409, 'CONFLICT', 'A category with this name already exists');
}

function activeCategoriesOwnedBy(ownerId: string) {
  return { ownerId, deletedAt: null };
}

function activeCategoryOwnedBy(ownerId: string, categoryId: string) {
  return { ...activeCategoriesOwnedBy(ownerId), _id: categoryId };
}

async function rejectingDuplicateNames<Result>(write: () => Promise<Result>): Promise<Result> {
  try {
    return await write();
  } catch (error) {
    if (isDuplicateKeyError(error)) throw categoryNameTakenError();
    throw error;
  }
}

function toCategoryUpdate({ name, description }: CategoryChanges) {
  return {
    $set: {
      ...(name !== undefined && { name, normalizedName: toCaseInsensitiveKey(name) }),
      ...(typeof description === 'string' && { description }),
    },
    $unset: { ...(description === null && { description: '' }) },
  };
}

export async function createCategory(
  ownerId: string,
  { name, description }: NewCategory,
): Promise<CategoryDto> {
  const category = await rejectingDuplicateNames(() =>
    new CategoryModel({
      ownerId,
      name,
      normalizedName: toCaseInsensitiveKey(name),
      ...(description !== undefined && { description }),
    }).save(),
  );
  return toPublicCategory(category.toObject());
}

export async function listCategoriesOwnedByUser(
  ownerId: string,
  { page, limit }: CategoryListQuery,
): Promise<CategoryPage> {
  const filter = activeCategoriesOwnedBy(ownerId);
  const [categories, total] = await Promise.all([
    CategoryModel.find(filter)
      .sort(ALPHABETICAL)
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    CategoryModel.countDocuments(filter),
  ]);
  return {
    categories: categories.map(toPublicCategory),
    pagination: toPaginationMeta(page, limit, total),
  };
}

export async function findCategoryOwnedByUser(
  ownerId: string,
  categoryId: string,
): Promise<CategoryDto> {
  const category = await CategoryModel.findOne(activeCategoryOwnedBy(ownerId, categoryId)).lean();
  if (!category) throw categoryNotFoundError();
  return toPublicCategory(category);
}

export async function updateCategoryOwnedByUser(
  ownerId: string,
  categoryId: string,
  changes: CategoryChanges,
): Promise<CategoryDto> {
  const category = await rejectingDuplicateNames(() =>
    CategoryModel.findOneAndUpdate(
      activeCategoryOwnedBy(ownerId, categoryId),
      toCategoryUpdate(changes),
      { returnDocument: 'after', runValidators: true },
    ).lean(),
  );
  if (!category) throw categoryNotFoundError();
  return toPublicCategory(category);
}

export async function deleteCategoryOwnedByUser(ownerId: string, categoryId: string) {
  const { matchedCount } = await CategoryModel.updateOne(
    activeCategoryOwnedBy(ownerId, categoryId),
    { $set: { deletedAt: new Date() } },
  );
  if (matchedCount === 0) throw categoryNotFoundError();
}

/*
 * Membership writes are single atomic updates on the active, owned category, so concurrent adds
 * and removals never overwrite each other and a deleted category is never written to.
 */
export async function addBookToCategory(ownerId: string, categoryId: string, bookId: string) {
  await requireActiveBookOwnedByUser(ownerId, bookId);
  const { matchedCount } = await CategoryModel.updateOne(
    activeCategoryOwnedBy(ownerId, categoryId),
    { $addToSet: { bookIds: bookId } },
  );
  if (matchedCount === 0) throw categoryNotFoundError();
}

export async function removeBookFromCategory(ownerId: string, categoryId: string, bookId: string) {
  await requireActiveBookOwnedByUser(ownerId, bookId);
  const { matchedCount } = await CategoryModel.updateOne(
    activeCategoryOwnedBy(ownerId, categoryId),
    { $pull: { bookIds: bookId } },
  );
  if (matchedCount === 0) throw categoryNotFoundError();
}

export async function listBooksInCategory(
  ownerId: string,
  categoryId: string,
  pageQuery: CategoryListQuery,
): Promise<BookPage> {
  const category = await CategoryModel.findOne(activeCategoryOwnedBy(ownerId, categoryId))
    .select({ bookIds: 1 })
    .lean();
  if (!category) throw categoryNotFoundError();
  return listActiveBooksInMembershipOrder(ownerId, category.bookIds, pageQuery);
}

/** Active categories of the owner that contain the book, alphabetically. Callers check the book. */
export async function findCategoriesContainingBook(
  ownerId: string,
  bookId: string,
): Promise<CategoryDto[]> {
  const categories = await CategoryModel.find({
    ...activeCategoriesOwnedBy(ownerId),
    bookIds: bookId,
  })
    .sort(ALPHABETICAL)
    .lean();
  return categories.map(toPublicCategory);
}

/** Every category of the owner, deleted ones included, oldest first, for the data export. */
export async function* streamCategoriesForArchive(
  ownerId: string,
): AsyncGenerator<CategoryExportDto> {
  for await (const category of CategoryModel.find({ ownerId })
    .sort(ARCHIVE_ORDER)
    .lean()
    .cursor()) {
    yield toArchivedCategory(category);
  }
}
