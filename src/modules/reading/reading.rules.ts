import type { FieldValidationError } from '../../shared/request-validation.js';
import type { BookLengths } from '../books/book.service.js';
import type { BookReadingStatus } from './reading.dto.js';
import type { ReadingProgress, ReadingSessionStatus } from './reading.schema.js';

export interface ReadingSessionDates {
  status: ReadingSessionStatus;
  startedOn: string | undefined;
  completedOn: string | undefined;
}

export function problemsWithReadingDates({
  status,
  startedOn,
  completedOn,
}: ReadingSessionDates): FieldValidationError[] {
  const problems: FieldValidationError[] = [];
  if (completedOn !== undefined && status !== 'completed') {
    problems.push({
      field: 'completedOn',
      message: 'can only be set on a completed reading session',
    });
  }
  if (startedOn !== undefined && completedOn !== undefined && completedOn < startedOn) {
    problems.push({ field: 'completedOn', message: 'must be on or after startedOn' });
  }
  return problems;
}

export function problemsWithProgress(
  progress: ReadingProgress,
  { pageCount, chapterCount }: BookLengths,
): FieldValidationError[] {
  if (progress.unit === 'pages' && pageCount !== undefined && progress.value > pageCount) {
    return [{ field: 'progress.value', message: "must not exceed the book's page count" }];
  }
  if (progress.unit === 'chapters' && chapterCount !== undefined && progress.value > chapterCount) {
    return [{ field: 'progress.value', message: "must not exceed the book's chapter count" }];
  }
  return [];
}

/**
 * A book's current reading status. An in-progress session wins even after earlier completed
 * reads, because the reader is rereading it; the per-book overview and the dashboard both use this.
 */
export function readingStatusOf(
  hasSessionInProgress: boolean,
  completedSessions: number,
): BookReadingStatus {
  if (hasSessionInProgress) return 'reading';
  if (completedSessions > 0) return 'completed';
  return 'unread';
}
