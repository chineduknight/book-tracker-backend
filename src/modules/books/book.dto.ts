import type { PaginatedResponseBody, SuccessResponseBody } from '../../shared/api-response.js';
import type { BookRecord } from './book.model.js';

export type BookFormat = 'physical' | 'ebook';
export type DuplicateMatchReason = 'title' | 'isbn';

export interface BookDto {
  id: string;
  title: string;
  authors: string[];
  format: BookFormat;
  isbn?: string;
  edition?: string;
  description?: string;
  coverUrl?: string;
  pageCount?: number;
  chapterCount?: number;
  publicationYear?: number;
  createdAt: string;
  updatedAt: string;
}

export interface DuplicateSuggestionDto {
  book: BookDto;
  matchedOn: DuplicateMatchReason[];
}

export type BookResponseBody = SuccessResponseBody<BookDto>;
export type BookListResponseBody = PaginatedResponseBody<BookDto>;
export type DuplicateCheckResponseBody = SuccessResponseBody<{ matches: DuplicateSuggestionDto[] }>;

export function toPublicBook(book: BookRecord): BookDto {
  return {
    id: book._id.toHexString(),
    title: book.title,
    authors: [...book.authors],
    format: book.format,
    ...(book.isbn != null && { isbn: book.isbn }),
    ...(book.edition != null && { edition: book.edition }),
    ...(book.description != null && { description: book.description }),
    ...(book.coverUrl != null && { coverUrl: book.coverUrl }),
    ...(book.pageCount != null && { pageCount: book.pageCount }),
    ...(book.chapterCount != null && { chapterCount: book.chapterCount }),
    ...(book.publicationYear != null && { publicationYear: book.publicationYear }),
    createdAt: book.createdAt.toISOString(),
    updatedAt: book.updatedAt.toISOString(),
  };
}
