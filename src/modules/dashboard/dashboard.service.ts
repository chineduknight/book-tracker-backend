import { utcCalendarDateOf } from '../../shared/calendar-date.js';
import { listActiveBookIdentities, listRecentlyAddedBooks } from '../books/book.service.js';
import { countVisibleCopiesOwnedByUser } from '../copies/copy.service.js';
import { countLoansOwnedByUser, listRecentlyRecordedLoans } from '../loans/loan.service.js';
import { countVisibleNotesByKind, listRecentlyAddedNotes } from '../notes/note.service.js';
import {
  listRecentlyRecordedSessions,
  tallyReadingSessionsOfActiveBooks,
} from '../reading/reading.service.js';
import {
  countWishlistItemsByStatus,
  listRecentlyAddedWishlistItems,
} from '../wishlist/wishlist.service.js';
import type {
  ActivityDto,
  ActivityType,
  DashboardSummaryDto,
  ReadingStatisticsDto,
} from './dashboard.dto.js';
import { newestActivities, tallyReadingStatistics } from './dashboard.rules.js';
import type { RecentActivityQuery, SummaryQuery } from './dashboard.schema.js';

function toActivity(
  type: ActivityType,
  resourceId: string,
  bookId: string | null,
  createdAt: Date,
): ActivityDto {
  return { type, resourceId, bookId, occurredAt: createdAt.toISOString() };
}

async function readingStatisticsOf(ownerId: string): Promise<ReadingStatisticsDto> {
  const [books, tallies] = await Promise.all([
    listActiveBookIdentities(ownerId),
    tallyReadingSessionsOfActiveBooks(ownerId),
  ]);
  return tallyReadingStatistics(books, tallies);
}

/*
 * Each counter comes from its own owner-scoped query, so under concurrent writes two counters may
 * reflect slightly different instants; there is no cross-collection snapshot without transactions.
 */
export async function findDashboardSummary(
  ownerId: string,
  { asOf = utcCalendarDateOf(new Date()) }: SummaryQuery,
): Promise<DashboardSummaryDto> {
  const [readingStatistics, physicalCopies, noteCounts, wishlistCounts, loanCounts] =
    await Promise.all([
      readingStatisticsOf(ownerId),
      countVisibleCopiesOwnedByUser(ownerId),
      countVisibleNotesByKind(ownerId),
      countWishlistItemsByStatus(ownerId),
      countLoansOwnedByUser(ownerId, asOf),
    ]);
  const { overall, byFormat } = readingStatistics;

  return {
    asOf,
    catalogue: {
      totalBooks: overall.books.total,
      physicalBooks: byFormat.physical.books.total,
      ebooks: byFormat.ebook.books.total,
      physicalCopies,
    },
    reading: {
      unreadBooks: overall.books.unread,
      currentlyReadingBooks: overall.books.reading,
      completedBooks: overall.books.completed,
      booksEverCompleted: overall.books.everCompleted,
      totalSessions: overall.sessions.total,
      completedSessions: overall.sessions.completed,
      rereadSessions: overall.sessions.rereads,
    },
    notes: noteCounts,
    wishlist: wishlistCounts,
    lending: {
      activeLoans: loanCounts.active,
      overdueLoans: loanCounts.overdue,
      returnedLoans: loanCounts.returned,
    },
  };
}

export async function findReadingStatistics(ownerId: string): Promise<ReadingStatisticsDto> {
  return readingStatisticsOf(ownerId);
}

/*
 * Each source returns at most `limit` of its newest visible records, so the merged newest
 * `limit` across sources is exact without reading anything else.
 */
export async function findRecentActivity(
  ownerId: string,
  { limit }: RecentActivityQuery,
): Promise<ActivityDto[]> {
  const [books, sessions, notes, wishlistItems, loans] = await Promise.all([
    listRecentlyAddedBooks(ownerId, limit),
    listRecentlyRecordedSessions(ownerId, limit),
    listRecentlyAddedNotes(ownerId, limit),
    listRecentlyAddedWishlistItems(ownerId, limit),
    listRecentlyRecordedLoans(ownerId, limit),
  ]);

  return newestActivities(
    [
      ...books.map((book) => toActivity('book_added', book.bookId, book.bookId, book.createdAt)),
      ...sessions.map((session) =>
        toActivity(
          'reading_session_recorded',
          session.sessionId,
          session.bookId,
          session.createdAt,
        ),
      ),
      ...notes.map((note) =>
        toActivity(
          note.kind === 'note' ? 'note_added' : 'highlight_added',
          note.noteId,
          note.bookId,
          note.createdAt,
        ),
      ),
      ...wishlistItems.map((item) =>
        toActivity('wishlist_item_added', item.wishlistItemId, null, item.createdAt),
      ),
      ...loans.map((loan) => toActivity('loan_recorded', loan.loanId, loan.bookId, loan.createdAt)),
    ],
    limit,
  );
}
