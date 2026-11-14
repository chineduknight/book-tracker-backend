import { utcCalendarDateOf } from '../../shared/calendar-date.js';
import {
  streamBooksForArchive,
  streamBookTitlesForArchive,
  type ArchivedBookTitle,
} from '../books/book.service.js';
import { streamCategoriesForArchive } from '../categories/category.service.js';
import { streamCollectionsForArchive } from '../collections/collection.service.js';
import { streamCopiesForArchive } from '../copies/copy.service.js';
import { streamLoansForArchive } from '../loans/loan.service.js';
import { streamLocationsForArchive } from '../locations/location.service.js';
import { streamNotesForArchive } from '../notes/note.service.js';
import { streamReadingSessionsForArchive } from '../reading/reading.service.js';
import type { UserDto } from '../users/user.dto.js';
import { streamWishlistItemsForArchive } from '../wishlist/wishlist.service.js';
import { toCsvRecord } from './export.csv.js';
import {
  ARCHIVE_SCHEMA_VERSION,
  type ArchiveDto,
  type ArchiveSection,
  type Download,
} from './export.dto.js';
import { BoundedExportWriter, type ExportLimits } from './export.limits.js';
import { noteSection, notesDocumentHeader } from './export.markdown.js';
import {
  BOOKS_TABLE,
  LOANS_TABLE,
  READING_SESSIONS_TABLE,
  type CsvTable,
} from './export.tables.js';

const JSON_TYPE = 'application/json; charset=utf-8';
const CSV_TYPE = 'text/csv; charset=utf-8';
const MARKDOWN_TYPE = 'text/markdown; charset=utf-8';

type SectionReader<Section extends ArchiveSection> = (
  ownerId: string,
) => AsyncIterable<ArchiveDto[Section][number]>;

/** The archive sections in the order they appear in the document, each read from its module. */
const ARCHIVE_SECTIONS: { [Section in ArchiveSection]: SectionReader<Section> } = {
  books: streamBooksForArchive,
  locations: streamLocationsForArchive,
  copies: streamCopiesForArchive,
  readingSessions: streamReadingSessionsForArchive,
  notes: streamNotesForArchive,
  categories: streamCategoriesForArchive,
  collections: streamCollectionsForArchive,
  wishlist: streamWishlistItemsForArchive,
  loans: streamLoansForArchive,
};

/** One download for a reader whose account was confirmed to exist; `profile.id` is the owner. */
export interface ExportRequest {
  profile: UserDto;
  exportedAt: Date;
  limits: ExportLimits;
}

function filenameOf(kind: string, exportedAt: Date, extension: string): string {
  return `book-tracker-${kind}-${utcCalendarDateOf(exportedAt)}.${extension}`;
}

async function writeJsonArray(writer: BoundedExportWriter, items: AsyncIterable<unknown>) {
  writer.write('[');
  let separator = '';
  for await (const item of items) {
    writer.countRecord();
    writer.write(separator + JSON.stringify(item));
    separator = ',';
  }
  writer.write(']');
}

async function buildCsv<Row>(
  table: CsvTable<Row>,
  rows: AsyncIterable<Row>,
  limits: ExportLimits,
): Promise<string> {
  const writer = new BoundedExportWriter(limits);
  writer.write(toCsvRecord(table.columns));
  for await (const row of rows) {
    writer.countRecord();
    writer.write(toCsvRecord(table.valuesOf(row)));
  }
  return writer.toString();
}

/*
 * The archive is written section by section in ArchiveDto key order, exactly as JSON.stringify
 * would write the whole object, but checking the limits as each record is added. Sections are
 * read one after another, so they are not one point-in-time snapshot.
 */
export async function buildArchiveDownload({
  profile,
  exportedAt,
  limits,
}: ExportRequest): Promise<Download> {
  const writer = new BoundedExportWriter(limits);
  writer.write(
    `{"data":{"schemaVersion":${ARCHIVE_SCHEMA_VERSION},` +
      `"exportedAt":${JSON.stringify(exportedAt.toISOString())},` +
      `"profile":${JSON.stringify(profile)}`,
  );
  for (const [section, readSection] of Object.entries(ARCHIVE_SECTIONS)) {
    writer.write(`,${JSON.stringify(section)}:`);
    await writeJsonArray(writer, readSection(profile.id));
  }
  writer.write('}}');

  return {
    filename: filenameOf('export', exportedAt, 'json'),
    contentType: JSON_TYPE,
    body: writer.toString(),
  };
}

export async function buildBooksCsvDownload({
  profile,
  exportedAt,
  limits,
}: ExportRequest): Promise<Download> {
  const ownerId = profile.id;
  return {
    filename: filenameOf('books', exportedAt, 'csv'),
    contentType: CSV_TYPE,
    body: await buildCsv(BOOKS_TABLE, streamBooksForArchive(ownerId), limits),
  };
}

export async function buildReadingSessionsCsvDownload({
  profile,
  exportedAt,
  limits,
}: ExportRequest): Promise<Download> {
  const ownerId = profile.id;
  return {
    filename: filenameOf('reading-sessions', exportedAt, 'csv'),
    contentType: CSV_TYPE,
    body: await buildCsv(READING_SESSIONS_TABLE, streamReadingSessionsForArchive(ownerId), limits),
  };
}

export async function buildLoansCsvDownload({
  profile,
  exportedAt,
  limits,
}: ExportRequest): Promise<Download> {
  const ownerId = profile.id;
  return {
    filename: filenameOf('loans', exportedAt, 'csv'),
    contentType: CSV_TYPE,
    body: await buildCsv(LOANS_TABLE, streamLoansForArchive(ownerId), limits),
  };
}

/*
 * Book titles come only from the reader's own books, deleted ones included; a note whose book is
 * not among them shows the book id instead. Titles count towards the record limit too.
 */
export async function buildNotesMarkdownDownload({
  profile,
  exportedAt,
  limits,
}: ExportRequest): Promise<Download> {
  const ownerId = profile.id;
  const writer = new BoundedExportWriter(limits);
  const booksById = new Map<string, ArchivedBookTitle>();
  for await (const book of streamBookTitlesForArchive(ownerId)) {
    writer.countRecord();
    booksById.set(book.bookId, book);
  }

  let entries = 0;
  for await (const note of streamNotesForArchive(ownerId)) {
    writer.countRecord();
    entries += 1;
    writer.write(noteSection(note, entries, booksById.get(note.bookId)));
  }
  writer.prepend(notesDocumentHeader(exportedAt.toISOString(), entries));

  return {
    filename: filenameOf('notes', exportedAt, 'md'),
    contentType: MARKDOWN_TYPE,
    body: writer.toString(),
  };
}
