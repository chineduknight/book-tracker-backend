import { expect } from 'vitest';
import type { DashboardSummaryDto } from '../../src/modules/dashboard/dashboard.dto.js';
import { addEbook, addPhysicalBook, startSession, type LibraryReader } from './library-fixtures.js';

/**
 * Five books covering every reading situation. Physical: Unread (no sessions), Reading (one
 * in-progress session), Rereading (completed, then in progress). Ebook: Completed (one completed
 * session), Thrice (three completed sessions). Optional dates are mostly left out on purpose.
 */
export async function addBooksInEveryReadingState(reader: LibraryReader) {
  const unread = await addPhysicalBook(reader, 'Unread');
  const reading = await addPhysicalBook(reader, 'Reading');
  await startSession(reader, reading.id);
  const rereading = await addPhysicalBook(reader, 'Rereading');
  await startSession(reader, rereading.id, { status: 'completed', completedOn: '2025-01-02' });
  await startSession(reader, rereading.id, { startedOn: '2026-11-01' });
  const completed = await addEbook(reader, 'Completed');
  await startSession(reader, completed.id, { status: 'completed' });
  const thrice = await addEbook(reader, 'Thrice');
  for (const startedOn of [undefined, '2020-01-01', undefined]) {
    await startSession(reader, thrice.id, {
      status: 'completed',
      ...(startedOn !== undefined && { startedOn }),
    });
  }
  return { unread, reading, rereading, completed, thrice };
}

export const EMPTY_SUMMARY: Omit<DashboardSummaryDto, 'asOf'> = {
  catalogue: { totalBooks: 0, physicalBooks: 0, ebooks: 0, physicalCopies: 0 },
  reading: {
    unreadBooks: 0,
    currentlyReadingBooks: 0,
    completedBooks: 0,
    booksEverCompleted: 0,
    totalSessions: 0,
    completedSessions: 0,
    rereadSessions: 0,
  },
  notes: { notes: 0, highlights: 0 },
  wishlist: { wanted: 0, acquired: 0 },
  lending: { activeLoans: 0, overdueLoans: 0, returnedLoans: 0 },
};

/** The invariants every summary must satisfy, whatever the data. */
export function expectConsistentSummary({ catalogue, reading, lending }: DashboardSummaryDto) {
  expect(catalogue.totalBooks).toBe(catalogue.physicalBooks + catalogue.ebooks);
  expect(catalogue.totalBooks).toBe(
    reading.unreadBooks + reading.currentlyReadingBooks + reading.completedBooks,
  );
  expect(reading.completedBooks).toBeLessThanOrEqual(reading.booksEverCompleted);
  expect(reading.booksEverCompleted).toBeLessThanOrEqual(catalogue.totalBooks);
  expect(reading.completedSessions).toBeLessThanOrEqual(reading.totalSessions);
  expect(reading.rereadSessions).toBeLessThanOrEqual(reading.totalSessions);
  expect(lending.overdueLoans).toBeLessThanOrEqual(lending.activeLoans);
}
