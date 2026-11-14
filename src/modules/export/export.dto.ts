import type { BookExportDto } from '../books/book.dto.js';
import type { CategoryExportDto } from '../categories/category.dto.js';
import type { BookCollectionExportDto } from '../collections/collection.dto.js';
import type { PhysicalCopyExportDto } from '../copies/copy.dto.js';
import type { LoanDto } from '../loans/loan.dto.js';
import type { StorageLocationDto } from '../locations/location.dto.js';
import type { NoteExportDto } from '../notes/note.dto.js';
import type { ReadingSessionDto } from '../reading/reading.dto.js';
import type { UserDto } from '../users/user.dto.js';
import type { WishlistItemExportDto } from '../wishlist/wishlist.dto.js';

export const ARCHIVE_SCHEMA_VERSION = 1;

export type GroupExportDto = CategoryExportDto | BookCollectionExportDto;

/** The complete, portable record of one reader's library, soft-deleted records included. */
export interface ArchiveDto {
  schemaVersion: typeof ARCHIVE_SCHEMA_VERSION;
  exportedAt: string;
  profile: UserDto;
  books: BookExportDto[];
  locations: StorageLocationDto[];
  copies: PhysicalCopyExportDto[];
  readingSessions: ReadingSessionDto[];
  notes: NoteExportDto[];
  categories: GroupExportDto[];
  collections: GroupExportDto[];
  wishlist: WishlistItemExportDto[];
  loans: LoanDto[];
}

export type ArchiveSection = Exclude<keyof ArchiveDto, 'schemaVersion' | 'exportedAt' | 'profile'>;

/** A finished download, built completely before anything is sent. */
export interface Download {
  filename: string;
  contentType: string;
  body: string;
}
