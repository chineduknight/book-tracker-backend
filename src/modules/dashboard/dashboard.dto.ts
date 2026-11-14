import type { SuccessResponseBody } from '../../shared/api-response.js';

export interface DashboardSummaryDto {
  asOf: string;
  catalogue: {
    totalBooks: number;
    physicalBooks: number;
    ebooks: number;
    physicalCopies: number;
  };
  reading: {
    unreadBooks: number;
    currentlyReadingBooks: number;
    completedBooks: number;
    booksEverCompleted: number;
    totalSessions: number;
    completedSessions: number;
    rereadSessions: number;
  };
  notes: { notes: number; highlights: number };
  wishlist: { wanted: number; acquired: number };
  lending: { activeLoans: number; overdueLoans: number; returnedLoans: number };
}

export interface ReadingStatisticsCountsDto {
  books: {
    total: number;
    unread: number;
    reading: number;
    completed: number;
    everCompleted: number;
  };
  sessions: {
    total: number;
    inProgress: number;
    completed: number;
    rereads: number;
  };
}

export interface ReadingStatisticsDto {
  overall: ReadingStatisticsCountsDto;
  byFormat: {
    physical: ReadingStatisticsCountsDto;
    ebook: ReadingStatisticsCountsDto;
  };
}

export type ActivityType =
  | 'book_added'
  | 'reading_session_recorded'
  | 'note_added'
  | 'highlight_added'
  | 'wishlist_item_added'
  | 'loan_recorded';

/** A record the reader created, identified only; clients fetch details separately. */
export interface ActivityDto {
  type: ActivityType;
  resourceId: string;
  bookId: string | null;
  occurredAt: string;
}

export type DashboardSummaryResponseBody = SuccessResponseBody<DashboardSummaryDto>;
export type ReadingStatisticsResponseBody = SuccessResponseBody<ReadingStatisticsDto>;
export type RecentActivityResponseBody = SuccessResponseBody<ActivityDto[]>;
