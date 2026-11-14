import type { BookExportDto } from '../books/book.dto.js';
import type { LoanDto } from '../loans/loan.dto.js';
import type { ReadingSessionDto } from '../reading/reading.dto.js';
import type { CsvValue } from './export.csv.js';

/** A spreadsheet export: its column names and how one record fills them, in the same order. */
export interface CsvTable<Row> {
  columns: readonly string[];
  valuesOf(row: Row): CsvValue[];
}

export const BOOKS_TABLE: CsvTable<BookExportDto> = {
  columns: [
    'id',
    'title',
    'authors',
    'format',
    'isbn',
    'edition',
    'description',
    'coverUrl',
    'pageCount',
    'chapterCount',
    'publicationYear',
    'createdAt',
    'updatedAt',
    'deletedAt',
  ],
  valuesOf: (book) => [
    book.id,
    book.title,
    JSON.stringify(book.authors),
    book.format,
    book.isbn,
    book.edition,
    book.description,
    book.coverUrl,
    book.pageCount,
    book.chapterCount,
    book.publicationYear,
    book.createdAt,
    book.updatedAt,
    book.deletedAt,
  ],
};

export const READING_SESSIONS_TABLE: CsvTable<ReadingSessionDto> = {
  columns: [
    'id',
    'bookId',
    'status',
    'progressUnit',
    'progressValue',
    'startedOn',
    'completedOn',
    'rating',
    'summary',
    'createdAt',
    'updatedAt',
  ],
  valuesOf: (session) => [
    session.id,
    session.bookId,
    session.status,
    session.progress?.unit,
    session.progress?.value,
    session.startedOn,
    session.completedOn,
    session.rating,
    session.summary,
    session.createdAt,
    session.updatedAt,
  ],
};

export const LOANS_TABLE: CsvTable<LoanDto> = {
  columns: [
    'id',
    'copyId',
    'bookId',
    'borrowerName',
    'borrowerContact',
    'lentOn',
    'dueOn',
    'returnedOn',
    'note',
    'createdAt',
    'updatedAt',
  ],
  valuesOf: (loan) => [
    loan.id,
    loan.copyId,
    loan.bookId,
    loan.borrowerName,
    loan.borrowerContact,
    loan.lentOn,
    loan.dueOn,
    loan.returnedOn,
    loan.note,
    loan.createdAt,
    loan.updatedAt,
  ],
};
