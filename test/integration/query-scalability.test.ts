import type { Express } from 'express';
import { describe, expect, it } from 'vitest';
import { createAuthTestApp } from './auth-fixtures.js';
import { signInLibraryReader, type LibraryReader } from './library-fixtures.js';
import { profileOperations, type ProfiledOperation } from './query-profile.js';
import { PERSONAL_LIBRARY, seedLibrary, TINY_LIBRARY, type LibrarySize } from './scale-fixtures.js';

/*
 * A read-side scalability audit on realistic data: a reader with a personal-sized library
 * (PERSONAL_LIBRARY), a second reader with the same amount of noise, and a reader with a tiny
 * library. The profiler records the queries the real endpoints send. Assertions avoid wall-clock
 * times and single planner choices that differ between MongoDB 7 and 8; set QUERY_PLAN_REPORT=1 to
 * print the measurements recorded in docs/hardening-audit.md.
 */

interface SeededReader {
  reader: LibraryReader;
  bookId: string;
  copyId: string;
  categoryId: string;
}

interface QueryShape {
  label: string;
  view: (seeded: SeededReader) => PromiseLike<{ status: number }>;
  /** For paged finds served in index order: documents examined may not exceed page × limit. */
  examinesAtMost?: number;
}

const QUERY_SHAPES: Record<string, QueryShape[]> = {
  'catalogue and copies': [
    {
      label: 'books, page 2',
      view: ({ reader }) => reader.books.list({ page: '2' }),
      examinesAtMost: 40,
    },
    {
      label: 'books by title, page 3',
      view: ({ reader }) => reader.books.list({ sort: 'title_asc', page: '3' }),
      examinesAtMost: 60,
    },
    { label: 'book search', view: ({ reader }) => reader.books.list({ q: 'Seeded' }) },
    {
      label: 'duplicate check',
      view: ({ reader }) => reader.books.duplicateCheck({ title: 'Seeded book 5' }),
    },
    { label: 'copies of a book', view: ({ reader, bookId }) => reader.copies.listForBook(bookId) },
  ],
  reading: [
    {
      label: 'global history, page 3',
      view: ({ reader }) => reader.reading.listAll({ page: '3' }),
    },
    {
      label: 'global history by status',
      view: ({ reader }) => reader.reading.listAll({ status: 'completed' }),
    },
    {
      label: 'history of a book',
      view: ({ reader, bookId }) => reader.reading.listForBook(bookId),
    },
    { label: 'overview of a book', view: ({ reader, bookId }) => reader.reading.overview(bookId) },
  ],
  notes: [
    { label: 'all notes, page 5', view: ({ reader }) => reader.notes.listAll({ page: '5' }) },
    { label: 'note search', view: ({ reader }) => reader.notes.listAll({ q: 'chapter' }) },
    {
      label: 'chapter filter',
      view: ({ reader }) => reader.notes.listAll({ chapter: 'Chapter 3' }),
    },
    { label: 'notes of a book', view: ({ reader, bookId }) => reader.notes.listForBook(bookId) },
  ],
  'groups and wishlist': [
    {
      label: 'books of a category, page 3',
      view: ({ reader, categoryId }) => reader.categories.listBooks(categoryId, { page: '3' }),
    },
    { label: 'groups of a book', view: ({ reader, bookId }) => reader.organizationOf(bookId) },
    { label: 'wishlist', view: ({ reader }) => reader.wishlist.list(), examinesAtMost: 20 },
    {
      label: 'wishlist by priority',
      view: ({ reader }) => reader.wishlist.list({ sort: 'priority' }),
    },
    { label: 'wishlist search', view: ({ reader }) => reader.wishlist.list({ q: 'wish' }) },
  ],
  loans: [
    { label: 'active loans', view: ({ reader }) => reader.loans.listAll(), examinesAtMost: 20 },
    { label: 'overdue loans', view: ({ reader }) => reader.loans.listAll({ status: 'overdue' }) },
    { label: 'returned loans', view: ({ reader }) => reader.loans.listAll({ status: 'returned' }) },
    {
      label: 'loans of a copy',
      view: ({ reader, copyId }) => reader.loans.listForCopy(copyId, { status: 'all' }),
    },
  ],
  'dashboard and export': [
    { label: 'dashboard summary', view: ({ reader }) => reader.dashboard.summary() },
    { label: 'reading statistics', view: ({ reader }) => reader.dashboard.readingStatistics() },
    {
      label: 'recent activity',
      view: ({ reader }) => reader.dashboard.recentActivity({ limit: '20' }),
    },
    { label: 'archive', view: ({ reader }) => reader.exports.archive() },
    { label: 'notes Markdown', view: ({ reader }) => reader.exports.notesMarkdown() },
  ],
};

async function seededReader(app: Express, size: LibrarySize): Promise<SeededReader> {
  const reader = await signInLibraryReader(app);
  const { bookIds, copyIds } = await seedLibrary(reader.userId, size);
  const [category] = (await reader.categories.list()).body.data as { id: string }[];
  return {
    reader,
    bookId: bookIds[1]?.toHexString() ?? '',
    copyId: copyIds[1]?.toHexString() ?? '',
    categoryId: category?.id ?? '',
  };
}

async function measure(shape: QueryShape, seeded: SeededReader) {
  let status = 0;
  const operations = await profileOperations(async () => {
    status = (await shape.view(seeded)).status;
  });
  expect(status, shape.label).toBe(200);
  return operations;
}

/** Index bounds of every scan in a plan summary, such as `{ ownerId: 1, deletedAt: 1 }`. */
function scannedIndexesOf({ planSummary }: ProfiledOperation): string[] {
  return [...planSummary.matchAll(/(?:IXSCAN|COUNT_SCAN) (\{[^}]*\})/g)].map(
    ([, keys]) => keys ?? '',
  );
}

/** Batches of one cursor are not separate queries, so they are left out of query counts. */
function queriesIn(operations: ProfiledOperation[]): ProfiledOperation[] {
  return operations.filter(({ op }) => op !== 'getmore');
}

function report(label: string, operations: ProfiledOperation[]) {
  if (process.env.QUERY_PLAN_REPORT !== '1') return;
  for (const operation of operations) {
    process.stdout.write(
      `| ${label} | ${operation.op} ${operation.collection} | ${operation.planSummary} | ` +
        `${operation.keysExamined} | ${operation.docsExamined} | ${operation.nreturned} | ` +
        `${operation.hasSortStage ? 'yes' : 'no'} |\n`,
    );
  }
}

describe('read-side query scalability', () => {
  it.each(Object.entries(QUERY_SHAPES))(
    '%s: owner-scoped index plans, bounded paging and a constant number of queries',
    async (_area, shapes) => {
      const app = createAuthTestApp();
      const personal = await seededReader(app, PERSONAL_LIBRARY);
      await seededReader(app, PERSONAL_LIBRARY);
      const tiny = await seededReader(app, TINY_LIBRARY);

      for (const shape of shapes) {
        const operations = await measure(shape, personal);
        report(shape.label, operations);

        for (const operation of operations) {
          const where = `${shape.label}: ${operation.collection} ${operation.planSummary}`;
          expect(operation.planSummary, where).not.toContain('COLLSCAN');
          for (const index of scannedIndexesOf(operation)) {
            expect(index, where).toMatch(/^\{ (ownerId|_id): /);
          }
        }
        if (shape.examinesAtMost !== undefined) {
          const pagedFind = operations.find(({ op }) => op === 'query');
          expect(pagedFind?.docsExamined, shape.label).toBeLessThanOrEqual(shape.examinesAtMost);
        }
        expect(queriesIn(await measure(shape, tiny)).length, shape.label).toBe(
          queriesIn(operations).length,
        );
      }
    },
    60_000,
  );
});
