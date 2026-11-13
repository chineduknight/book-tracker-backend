import { z } from 'zod';
import { collapseWhitespace, containsLetterOrDigit } from './book.normalization.js';

export const BOOK_FORMATS = ['physical', 'ebook'] as const;
const BOOK_SORT_ORDERS = ['recent', 'oldest', 'title_asc', 'title_desc'] as const;

const OBJECT_ID_HEX = /^[0-9a-fA-F]{24}$/;
const POSITIVE_WHOLE_NUMBER = /^[1-9][0-9]*$/;
const ONLY_ONCE = 'must be given only once';

const title = z.string().transform(collapseWhitespace).pipe(z.string().min(1).max(250));
const author = z.string().trim().min(1).max(120);
const authors = z.array(author).max(20);
const format = z.enum(BOOK_FORMATS);
const isbn = z
  .string()
  .trim()
  .max(32)
  .refine(containsLetterOrDigit, 'must contain at least one letter or digit');
const edition = z.string().trim().min(1).max(100);
const description = z.string().trim().min(1).max(5_000);
const coverUrl = z
  .string()
  .trim()
  .max(2_048)
  .pipe(z.url({ protocol: /^https?$/, error: 'must be an absolute http or https URL' }));
const pageCount = z.number().int().min(1).max(100_000);
const chapterCount = z.number().int().min(1).max(10_000);
const publicationYear = z.number().int().min(1).max(9_999);

export const createBookRequestSchema = z.strictObject({
  title,
  authors: authors.optional(),
  format,
  isbn: isbn.optional(),
  edition: edition.optional(),
  description: description.optional(),
  coverUrl: coverUrl.optional(),
  pageCount: pageCount.optional(),
  chapterCount: chapterCount.optional(),
  publicationYear: publicationYear.optional(),
});

export const updateBookRequestSchema = z
  .strictObject({
    title: title.optional(),
    authors: authors.optional(),
    format: format.optional(),
    isbn: isbn.nullable().optional(),
    edition: edition.nullable().optional(),
    description: description.nullable().optional(),
    coverUrl: coverUrl.nullable().optional(),
    pageCount: pageCount.nullable().optional(),
    chapterCount: chapterCount.nullable().optional(),
    publicationYear: publicationYear.nullable().optional(),
  })
  .refine((changes) => Object.keys(changes).length > 0, 'must change at least one field');

const singleQueryValue = z.string({
  error: (issue) => (Array.isArray(issue.input) ? ONLY_ONCE : 'must be a single text value'),
});

function singleQueryChoice<const Choices extends readonly [string, ...string[]]>(choices: Choices) {
  return z.enum(choices, {
    error: (issue) =>
      Array.isArray(issue.input) ? ONLY_ONCE : `must be one of: ${choices.join(', ')}`,
  });
}

const positiveWholeNumber = singleQueryValue
  .regex(POSITIVE_WHOLE_NUMBER, 'must be a positive whole number')
  .transform(Number)
  .pipe(z.number().int('is too large'));

export const listBooksQuerySchema = z.strictObject({
  page: positiveWholeNumber.default(1),
  limit: positiveWholeNumber.pipe(z.number().max(100)).default(20),
  q: singleQueryValue
    .trim()
    .max(120)
    .refine(containsLetterOrDigit, 'must contain at least one letter or digit')
    .optional(),
  format: singleQueryChoice(BOOK_FORMATS).optional(),
  sort: singleQueryChoice(BOOK_SORT_ORDERS).default('recent'),
});

export const duplicateCheckQuerySchema = z
  .strictObject({
    title: singleQueryValue.pipe(title).optional(),
    isbn: singleQueryValue.pipe(isbn).optional(),
  })
  .refine(
    (query) => query.title !== undefined || query.isbn !== undefined,
    'provide a title, an isbn or both',
  );

export const bookIdParamsSchema = z.strictObject({
  bookId: z.string().regex(OBJECT_ID_HEX, 'must be a 24-character hexadecimal id'),
});

export type NewBook = z.output<typeof createBookRequestSchema>;
export type BookChanges = z.output<typeof updateBookRequestSchema>;
export type BookListQuery = z.output<typeof listBooksQuerySchema>;
export type DuplicateCheckQuery = z.output<typeof duplicateCheckQuerySchema>;
export type BookSortOrder = (typeof BOOK_SORT_ORDERS)[number];
