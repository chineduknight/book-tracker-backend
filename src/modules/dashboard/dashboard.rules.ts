import type { BookIdentity } from '../books/book.service.js';
import { readingStatusOf } from '../reading/reading.rules.js';
import type { BookReadingTally } from '../reading/reading.service.js';
import type {
  ActivityDto,
  ReadingStatisticsCountsDto,
  ReadingStatisticsDto,
} from './dashboard.dto.js';

type SessionCounts = Omit<BookReadingTally, 'bookId'>;

const NO_SESSIONS: SessionCounts = { sessions: 0, completedSessions: 0, inProgressSessions: 0 };

function emptyCounts(): ReadingStatisticsCountsDto {
  return {
    books: { total: 0, unread: 0, reading: 0, completed: 0, everCompleted: 0 },
    sessions: { total: 0, inProgress: 0, completed: 0, rereads: 0 },
  };
}

function addBookTo(counts: ReadingStatisticsCountsDto, tally: SessionCounts): void {
  const status = readingStatusOf(tally.inProgressSessions > 0, tally.completedSessions);
  counts.books.total += 1;
  counts.books[status] += 1;
  if (tally.completedSessions > 0) counts.books.everCompleted += 1;
  counts.sessions.total += tally.sessions;
  counts.sessions.inProgress += tally.inProgressSessions;
  counts.sessions.completed += tally.completedSessions;
  counts.sessions.rereads += Math.max(0, tally.sessions - 1);
}

/**
 * Reading statistics of the given books. The book list decides which books exist, so the status
 * buckets always partition exactly the books counted; tallies of books not in the list are ignored.
 */
export function tallyReadingStatistics(
  books: readonly BookIdentity[],
  tallies: readonly BookReadingTally[],
): ReadingStatisticsDto {
  const tallyByBook = new Map(tallies.map((tally) => [tally.bookId, tally]));
  const statistics: ReadingStatisticsDto = {
    overall: emptyCounts(),
    byFormat: { physical: emptyCounts(), ebook: emptyCounts() },
  };
  for (const book of books) {
    const tally = tallyByBook.get(book.bookId) ?? NO_SESSIONS;
    addBookTo(statistics.overall, tally);
    addBookTo(statistics.byFormat[book.format], tally);
  }
  return statistics;
}

function compareNewestFirst(first: ActivityDto, second: ActivityDto): number {
  if (first.occurredAt !== second.occurredAt) return first.occurredAt < second.occurredAt ? 1 : -1;
  if (first.resourceId !== second.resourceId) return first.resourceId < second.resourceId ? 1 : -1;
  if (first.type === second.type) return 0;
  return first.type < second.type ? -1 : 1;
}

/** The newest activities: by time, then resource id (both descending), then type ascending. */
export function newestActivities(activities: readonly ActivityDto[], limit: number): ActivityDto[] {
  return [...activities].sort(compareNewestFirst).slice(0, limit);
}
