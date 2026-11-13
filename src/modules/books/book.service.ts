import mongoose, { type PipelineStage } from 'mongoose';
import { toPaginationMeta, type PaginationMeta } from '../../shared/api-response.js';
import { AppError } from '../../shared/errors.js';
import { toPublicBook, type BookDto, type DuplicateSuggestionDto } from './book.dto.js';
import { BookModel } from './book.model.js';
import { toTextSearchWords } from '../../shared/text.js';
import { normalizeIsbnForMatching, normalizeTitleForMatching } from './book.normalization.js';
import type {
  BookChanges,
  BookListQuery,
  BookSortOrder,
  DuplicateCheckQuery,
  NewBook,
} from './book.schema.js';

const MAX_DUPLICATE_SUGGESTIONS = 10;

const SORT_ORDERS = {
  recent: { createdAt: -1, _id: -1 },
  oldest: { createdAt: 1, _id: 1 },
  title_asc: { normalizedTitle: 1, _id: 1 },
  title_desc: { normalizedTitle: -1, _id: -1 },
} as const satisfies Record<BookSortOrder, Record<string, 1 | -1>>;

export interface BookPage {
  books: BookDto[];
  pagination: PaginationMeta;
}

function bookNotFoundError(): AppError {
  return new AppError(404, 'NOT_FOUND', 'Book not found');
}

function activeBooksOwnedBy(ownerId: string) {
  return { ownerId, deletedAt: null };
}

function activeBookOwnedBy(ownerId: string, bookId: string) {
  return { ...activeBooksOwnedBy(ownerId), _id: bookId };
}

function bookHasPhysicalCopiesError(): AppError {
  return new AppError(
    409,
    'BOOK_HAS_PHYSICAL_COPIES',
    'A book with physical copies cannot become an ebook',
  );
}

function bookNotPhysicalError(): AppError {
  return new AppError(
    409,
    'BOOK_NOT_PHYSICAL',
    'Physical copies can only be added to physical books',
  );
}

export async function isActiveBookOwnedByUser(ownerId: string, bookId: string): Promise<boolean> {
  return (await BookModel.exists(activeBookOwnedBy(ownerId, bookId))) !== null;
}

/*
 * Copy creation and the ebook format change coordinate through this single book document:
 * reserving sets hasPhysicalCopyHistory only while the book is physical, and the ebook change
 * only succeeds while the flag is unset. MongoDB applies both writes atomically to one document,
 * so whichever runs second fails and no copy can end up on an ebook.
 */
export async function reserveBookForPhysicalCopy(ownerId: string, bookId: string): Promise<void> {
  const { matchedCount } = await BookModel.updateOne(
    { ...activeBookOwnedBy(ownerId, bookId), format: 'physical' },
    { $set: { hasPhysicalCopyHistory: true } },
    { timestamps: false },
  );
  if (matchedCount === 1) return;
  if (await isActiveBookOwnedByUser(ownerId, bookId)) throw bookNotPhysicalError();
  throw bookNotFoundError();
}

export async function requireActiveBookOwnedByUser(ownerId: string, bookId: string) {
  if (!(await isActiveBookOwnedByUser(ownerId, bookId))) throw bookNotFoundError();
}

export interface BookLengths {
  pageCount?: number;
  chapterCount?: number;
}

/** Page and chapter counts of an active book of the owner, or null if the book is not visible. */
export async function findLengthsOfActiveBook(
  ownerId: string,
  bookId: string,
): Promise<BookLengths | null> {
  const book = await BookModel.findOne(activeBookOwnedBy(ownerId, bookId))
    .select({ pageCount: 1, chapterCount: 1 })
    .lean();
  if (!book) return null;
  return {
    ...(book.pageCount != null && { pageCount: book.pageCount }),
    ...(book.chapterCount != null && { chapterCount: book.chapterCount }),
  };
}

export async function requireLengthsOfActiveBook(
  ownerId: string,
  bookId: string,
): Promise<BookLengths> {
  const lengths = await findLengthsOfActiveBook(ownerId, bookId);
  if (!lengths) throw bookNotFoundError();
  return lengths;
}

/**
 * Aggregation stage that keeps only documents whose `bookIdField` refers to an active book of the
 * owner, so other modules can filter by parent visibility before counting and paginating.
 */
export function keepDocumentsOfActiveBooks(ownerId: string, bookIdField: string): PipelineStage[] {
  const activeBook = 'activeBook';
  return [
    {
      $lookup: {
        from: BookModel.collection.collectionName,
        localField: bookIdField,
        foreignField: '_id',
        pipeline: [
          { $match: { ownerId: new mongoose.Types.ObjectId(ownerId), deletedAt: null } },
          { $project: { _id: 1 } },
        ],
        as: activeBook,
      },
    },
    { $match: { [activeBook]: { $ne: [] } } },
    { $project: { [activeBook]: 0 } },
  ];
}

function toBookUpdate(changes: BookChanges) {
  const fieldsToSet: Record<string, unknown> = {};
  const fieldsToClear: Record<string, ''> = {};

  for (const [field, value] of Object.entries(changes)) {
    if (value === null) fieldsToClear[field] = '';
    else fieldsToSet[field] = value;
  }
  if (changes.title !== undefined) {
    fieldsToSet.normalizedTitle = normalizeTitleForMatching(changes.title);
  }
  if (changes.isbn === null) fieldsToClear.normalizedIsbn = '';
  if (typeof changes.isbn === 'string') {
    fieldsToSet.normalizedIsbn = normalizeIsbnForMatching(changes.isbn);
  }

  return { $set: fieldsToSet, $unset: fieldsToClear };
}

export async function createBook(ownerId: string, newBook: NewBook): Promise<BookDto> {
  const book = await new BookModel({
    ...newBook,
    ownerId,
    normalizedTitle: normalizeTitleForMatching(newBook.title),
    ...(newBook.isbn !== undefined && { normalizedIsbn: normalizeIsbnForMatching(newBook.isbn) }),
  }).save();
  return toPublicBook(book.toObject());
}

export async function findBookOwnedByUser(ownerId: string, bookId: string): Promise<BookDto> {
  const book = await BookModel.findOne(activeBookOwnedBy(ownerId, bookId)).lean();
  if (!book) throw bookNotFoundError();
  return toPublicBook(book);
}

export async function listBooksOwnedByUser(
  ownerId: string,
  { page, limit, q, format, sort }: BookListQuery,
): Promise<BookPage> {
  const filter = {
    ...activeBooksOwnedBy(ownerId),
    ...(format !== undefined && { format }),
    ...(q !== undefined && { $text: { $search: toTextSearchWords(q) } }),
  };

  const [books, total] = await Promise.all([
    BookModel.find(filter)
      .sort(SORT_ORDERS[sort])
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    BookModel.countDocuments(filter),
  ]);

  return {
    books: books.map(toPublicBook),
    pagination: toPaginationMeta(page, limit, total),
  };
}

export async function updateBookOwnedByUser(
  ownerId: string,
  bookId: string,
  changes: BookChanges,
): Promise<BookDto> {
  const becomesEbook = changes.format === 'ebook';
  const book = await BookModel.findOneAndUpdate(
    {
      ...activeBookOwnedBy(ownerId, bookId),
      ...(becomesEbook && { hasPhysicalCopyHistory: { $ne: true } }),
    },
    toBookUpdate(changes),
    { returnDocument: 'after', runValidators: true },
  ).lean();
  if (book) return toPublicBook(book);
  if (becomesEbook && (await isActiveBookOwnedByUser(ownerId, bookId))) {
    throw bookHasPhysicalCopiesError();
  }
  throw bookNotFoundError();
}

export async function deleteBookOwnedByUser(ownerId: string, bookId: string): Promise<void> {
  const { matchedCount } = await BookModel.updateOne(activeBookOwnedBy(ownerId, bookId), {
    $set: { deletedAt: new Date() },
  });
  if (matchedCount === 0) throw bookNotFoundError();
}

export async function findPossibleDuplicateBooks(
  ownerId: string,
  { title, isbn }: DuplicateCheckQuery,
): Promise<DuplicateSuggestionDto[]> {
  const normalizedTitle = title === undefined ? undefined : normalizeTitleForMatching(title);
  const normalizedIsbn = isbn === undefined ? undefined : normalizeIsbnForMatching(isbn);
  const matchingConditions = [
    ...(normalizedTitle === undefined ? [] : [{ normalizedTitle }]),
    ...(normalizedIsbn === undefined ? [] : [{ normalizedIsbn }]),
  ];

  const books = await BookModel.find({ ...activeBooksOwnedBy(ownerId), $or: matchingConditions })
    .sort(SORT_ORDERS.recent)
    .limit(MAX_DUPLICATE_SUGGESTIONS)
    .lean();

  return books.map((book) => ({
    book: toPublicBook(book),
    matchedOn: [
      ...(book.normalizedTitle === normalizedTitle ? (['title'] as const) : []),
      ...(normalizedIsbn !== undefined && book.normalizedIsbn === normalizedIsbn
        ? (['isbn'] as const)
        : []),
    ],
  }));
}
