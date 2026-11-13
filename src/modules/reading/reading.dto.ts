import type { PaginatedResponseBody, SuccessResponseBody } from '../../shared/api-response.js';
import type { ReadingSessionRecord } from './reading.model.js';

export type ReadingSessionStatusDto = 'in_progress' | 'completed';
export type BookReadingStatus = 'unread' | 'reading' | 'completed';

export type ReadingProgressDto =
  | { unit: 'pages'; value: number }
  | { unit: 'chapters'; value: number }
  | { unit: 'percent'; value: number };

export interface ReadingSessionDto {
  id: string;
  bookId: string;
  status: ReadingSessionStatusDto;
  progress: ReadingProgressDto | null;
  startedOn?: string;
  completedOn?: string;
  rating?: number;
  summary?: string;
  createdAt: string;
  updatedAt: string;
}

export interface BookReadingOverviewDto {
  bookId: string;
  status: BookReadingStatus;
  totalSessions: number;
  completedSessions: number;
  activeSession: ReadingSessionDto | null;
  lastCompletedSession: ReadingSessionDto | null;
}

export type ReadingSessionResponseBody = SuccessResponseBody<ReadingSessionDto>;
export type ReadingSessionListResponseBody = PaginatedResponseBody<ReadingSessionDto>;
export type BookReadingOverviewResponseBody = SuccessResponseBody<BookReadingOverviewDto>;

function toPublicProgress(progress: ReadingSessionRecord['progress']): ReadingProgressDto | null {
  if (progress == null) return null;
  return { unit: progress.unit, value: progress.value };
}

export function toPublicReadingSession(session: ReadingSessionRecord): ReadingSessionDto {
  return {
    id: session._id.toHexString(),
    bookId: session.bookId.toHexString(),
    status: session.status,
    progress: toPublicProgress(session.progress),
    ...(session.startedOn != null && { startedOn: session.startedOn }),
    ...(session.completedOn != null && { completedOn: session.completedOn }),
    ...(session.rating != null && { rating: session.rating }),
    ...(session.summary != null && { summary: session.summary }),
    createdAt: session.createdAt.toISOString(),
    updatedAt: session.updatedAt.toISOString(),
  };
}
