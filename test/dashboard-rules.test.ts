import { describe, expect, it } from 'vitest';
import type { BookIdentity } from '../src/modules/books/book.service.js';
import type { ActivityDto } from '../src/modules/dashboard/dashboard.dto.js';
import {
  newestActivities,
  tallyReadingStatistics,
} from '../src/modules/dashboard/dashboard.rules.js';
import { readingStatusOf } from '../src/modules/reading/reading.rules.js';
import type { BookReadingTally } from '../src/modules/reading/reading.service.js';

const book = (bookId: string, format: BookIdentity['format'] = 'physical'): BookIdentity => ({
  bookId,
  format,
});
const tally = (
  bookId: string,
  sessions: number,
  completedSessions: number,
  inProgressSessions: number,
): BookReadingTally => ({ bookId, sessions, completedSessions, inProgressSessions });

describe('readingStatusOf', () => {
  it.each([
    [false, 0, 'unread'],
    [true, 0, 'reading'],
    [true, 3, 'reading'],
    [false, 1, 'completed'],
  ] as const)('in progress %s with %i completed is %s', (inProgress, completed, status) => {
    expect(readingStatusOf(inProgress, completed)).toBe(status);
  });
});

describe('tallyReadingStatistics', () => {
  it('counts a book without sessions as unread', () => {
    const { overall } = tallyReadingStatistics([book('a')], []);

    expect(overall).toEqual({
      books: { total: 1, unread: 1, reading: 0, completed: 0, everCompleted: 0 },
      sessions: { total: 0, inProgress: 0, completed: 0, rereads: 0 },
    });
  });

  it('counts a reread in progress as reading and as ever completed', () => {
    const { overall } = tallyReadingStatistics([book('a')], [tally('a', 3, 2, 1)]);

    expect(overall).toEqual({
      books: { total: 1, unread: 0, reading: 1, completed: 0, everCompleted: 1 },
      sessions: { total: 3, inProgress: 1, completed: 2, rereads: 2 },
    });
  });

  it('splits by the book’s format and keeps the overall equal to the sum', () => {
    const statistics = tallyReadingStatistics(
      [book('a'), book('b', 'ebook'), book('c', 'ebook')],
      [tally('a', 1, 1, 0), tally('b', 2, 1, 1)],
    );

    expect(statistics.byFormat.physical.books).toEqual({
      total: 1,
      unread: 0,
      reading: 0,
      completed: 1,
      everCompleted: 1,
    });
    expect(statistics.byFormat.ebook.books).toEqual({
      total: 2,
      unread: 1,
      reading: 1,
      completed: 0,
      everCompleted: 1,
    });
    expect(statistics.overall.sessions).toEqual({
      total: 3,
      inProgress: 1,
      completed: 2,
      rereads: 1,
    });
  });

  it('ignores tallies of books that are not in the book list', () => {
    const { overall } = tallyReadingStatistics([book('a')], [tally('gone', 5, 5, 0)]);

    expect(overall.books.total).toBe(1);
    expect(overall.sessions.total).toBe(0);
  });
});

describe('newestActivities', () => {
  const activity = (
    type: ActivityDto['type'],
    resourceId: string,
    occurredAt: string,
  ): ActivityDto => ({
    type,
    resourceId,
    bookId: null,
    occurredAt,
  });

  it('orders by time, then resource id descending, then type ascending, and truncates', () => {
    const activities = [
      activity('note_added', 'a1', '2026-11-14T10:00:00.000Z'),
      activity('book_added', 'b2', '2026-11-14T10:00:00.000Z'),
      activity('loan_recorded', 'ff', '2026-11-14T10:00:00.000Z'),
      activity('book_added', 'ff', '2026-11-14T10:00:00.000Z'),
      activity('wishlist_item_added', 'c3', '2026-11-14T11:00:00.000Z'),
      activity('highlight_added', 'd4', '2026-11-14T09:00:00.000Z'),
    ];

    expect(newestActivities(activities, 5).map((item) => [item.type, item.resourceId])).toEqual([
      ['wishlist_item_added', 'c3'],
      ['book_added', 'ff'],
      ['loan_recorded', 'ff'],
      ['book_added', 'b2'],
      ['note_added', 'a1'],
    ]);
  });

  it('does not modify its input and returns an empty list for no activities', () => {
    const activities = [activity('book_added', 'a', '2026-01-01T00:00:00.000Z')];

    newestActivities(activities, 0);

    expect(activities).toHaveLength(1);
    expect(newestActivities([], 10)).toEqual([]);
  });
});
