import { describe, expect, it } from 'vitest';
import { WishlistItemModel } from '../../src/modules/wishlist/wishlist.model.js';
import { createAuthTestApp } from './auth-fixtures.js';
import {
  addEbook,
  addWish,
  invalidFieldsOf,
  paginationOf,
  signInLibraryReader,
  wishesFrom,
  type LibraryReader,
} from './library-fixtures.js';

const SAME_INSTANT = new Date('2026-01-01T00:00:00.000Z');

function titlesOf(res: { body: unknown }) {
  return wishesFrom(res).map((item) => item.title);
}

function idsOf(res: { body: unknown }) {
  return wishesFrom(res).map((item) => item.id);
}

async function seedWishes(reader: LibraryReader) {
  const low = await addWish(reader, {
    title: 'Zebra Tales',
    priority: 'low',
    authors: ['Ann Author'],
  });
  const high = await addWish(reader, {
    title: 'apple pie',
    priority: 'high',
    note: 'birthday gift',
  });
  const medium = await addWish(reader, { title: 'Émile', authors: ['Rousseau'] });
  const acquired = await addWish(reader, { title: 'Banana Bread', priority: 'high' });
  const book = await addEbook(reader, 'Banana Bread');
  expect((await reader.wishlist.acquire(acquired.id, { bookId: book.id })).status).toBe(200);
  return { low, high, medium, acquired, book };
}

describe('GET /api/v1/wishlist', () => {
  it('lists only wanted items by default, newest first, with pagination metadata', async () => {
    const reader = await signInLibraryReader(createAuthTestApp());
    const { low, high, medium } = await seedWishes(reader);

    const res = await reader.wishlist.list();

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(idsOf(res)).toEqual([medium.id, high.id, low.id]);
    expect(paginationOf(res)).toEqual({ page: 1, limit: 20, total: 3, totalPages: 1 });
  });

  it.each([
    ['acquired', ['Banana Bread']],
    ['all', ['Banana Bread', 'Émile', 'apple pie', 'Zebra Tales']],
    ['wanted', ['Émile', 'apple pie', 'Zebra Tales']],
  ])('filters by status %s', async (status, expected) => {
    const reader = await signInLibraryReader(createAuthTestApp());
    await seedWishes(reader);

    const res = await reader.wishlist.list({ status });

    expect(titlesOf(res)).toEqual(expected);
    expect(paginationOf(res).total).toBe(expected.length);
  });

  it('filters by priority, counting only matches', async () => {
    const reader = await signInLibraryReader(createAuthTestApp());
    await seedWishes(reader);

    expect(titlesOf(await reader.wishlist.list({ priority: 'high' }))).toEqual(['apple pie']);
    expect(titlesOf(await reader.wishlist.list({ priority: 'high', status: 'all' }))).toEqual([
      'Banana Bread',
      'apple pie',
    ]);
    expect(paginationOf(await reader.wishlist.list({ priority: 'low' })).total).toBe(1);
  });

  it.each([
    ['oldest', ['Zebra Tales', 'apple pie', 'Émile', 'Banana Bread']],
    ['title_asc', ['apple pie', 'Banana Bread', 'Zebra Tales', 'Émile']],
    ['title_desc', ['Émile', 'Zebra Tales', 'Banana Bread', 'apple pie']],
    ['priority', ['Banana Bread', 'apple pie', 'Émile', 'Zebra Tales']],
  ])('sorts by %s', async (sort, expected) => {
    const reader = await signInLibraryReader(createAuthTestApp());
    await seedWishes(reader);

    expect(titlesOf(await reader.wishlist.list({ sort, status: 'all' }))).toEqual(expected);
  });

  it('breaks ties on identical timestamps and titles by id in the sort direction', async () => {
    const reader = await signInLibraryReader(createAuthTestApp());
    const ids = [];
    for (let index = 0; index < 4; index += 1) {
      ids.push((await addWish(reader, { title: 'Same', priority: 'high' })).id);
    }
    await WishlistItemModel.collection.updateMany({}, { $set: { createdAt: SAME_INSTANT } });
    const ascending = [...ids].sort();

    expect(idsOf(await reader.wishlist.list())).toEqual([...ascending].reverse());
    expect(idsOf(await reader.wishlist.list({ sort: 'oldest' }))).toEqual(ascending);
    expect(idsOf(await reader.wishlist.list({ sort: 'title_asc' }))).toEqual(ascending);
    expect(idsOf(await reader.wishlist.list({ sort: 'title_desc' }))).toEqual(
      [...ascending].reverse(),
    );
    expect(idsOf(await reader.wishlist.list({ sort: 'priority' }))).toEqual(
      [...ascending].reverse(),
    );
  });

  it('pages with exact totals, no gaps and an empty page past the end', async () => {
    const reader = await signInLibraryReader(createAuthTestApp());
    const ids = [];
    for (let index = 0; index < 5; index += 1)
      ids.push((await addWish(reader, { title: `W${index}` })).id);

    const pages = await Promise.all(
      ['1', '2', '3', '4'].map((page) =>
        reader.wishlist.list({ sort: 'oldest', limit: '2', page }),
      ),
    );

    expect(pages.map(idsOf)).toEqual([ids.slice(0, 2), ids.slice(2, 4), ids.slice(4), []]);
    expect(paginationOf(pages[3]!)).toEqual({ page: 4, limit: 2, total: 5, totalPages: 3 });
  });

  it('returns an empty first page for a reader without wishes', async () => {
    const reader = await signInLibraryReader(createAuthTestApp());

    expect((await reader.wishlist.list()).body).toEqual({
      data: [],
      meta: { pagination: { page: 1, limit: 20, total: 0, totalPages: 0 } },
    });
  });

  it.each([
    ['an unknown parameter', { owner: 'me' }, ['owner']],
    ['a repeated parameter', 'status=all&status=wanted', ['status']],
    ['an unknown status', { status: 'deleted' }, ['status']],
    ['an unknown priority', { priority: 'urgent' }, ['priority']],
    ['an unknown sort', { sort: 'score' }, ['sort']],
    ['page zero', { page: '0' }, ['page']],
    ['a limit over 100', { limit: '101' }, ['limit']],
    ['a search without letters or digits', { q: '"-"' }, ['q']],
    ['a too long search', { q: 'q'.repeat(121) }, ['q']],
  ])('rejects %s with 400', async (_label, query, fields) => {
    const reader = await signInLibraryReader(createAuthTestApp());

    expect(invalidFieldsOf(await reader.wishlist.list(query))).toEqual(fields);
  });
});

describe('wishlist search', () => {
  it.each([
    ['title', 'zebra', ['Zebra Tales']],
    ['authors', 'rousseau', ['Émile']],
    ['note', 'birthday', ['apple pie']],
  ])('finds words in the %s', async (_field, q, expected) => {
    const reader = await signInLibraryReader(createAuthTestApp());
    await seedWishes(reader);

    expect(titlesOf(await reader.wishlist.list({ q }))).toEqual(expected);
  });

  it('ignores case and diacritics, matches whole terms and any of several words', async () => {
    const reader = await signInLibraryReader(createAuthTestApp());
    await seedWishes(reader);

    for (const q of ['émile', 'EMILE', 'Emile']) {
      expect(titlesOf(await reader.wishlist.list({ q }))).toEqual(['Émile']);
    }
    for (const q of ['zeb', 'zeb.*', '^Zeb', 'ta']) {
      expect({ q, found: titlesOf(await reader.wishlist.list({ q })) }).toEqual({ q, found: [] });
    }
    expect(titlesOf(await reader.wishlist.list({ q: 'zebra rousseau' }))).toEqual([
      'Émile',
      'Zebra Tales',
    ]);
  });

  it('treats quotes and hyphens as plain text and respects status and priority filters', async () => {
    const reader = await signInLibraryReader(createAuthTestApp());
    await seedWishes(reader);

    expect(titlesOf(await reader.wishlist.list({ q: '-zebra' }))).toEqual(['Zebra Tales']);
    expect(titlesOf(await reader.wishlist.list({ q: '"zebra birthday"' }))).toEqual([
      'apple pie',
      'Zebra Tales',
    ]);
    expect(titlesOf(await reader.wishlist.list({ q: 'banana' }))).toEqual([]);
    expect(titlesOf(await reader.wishlist.list({ q: 'banana', status: 'acquired' }))).toEqual([
      'Banana Bread',
    ]);
    const filtered = await reader.wishlist.list({ q: 'zebra apple', priority: 'low' });
    expect(titlesOf(filtered)).toEqual(['Zebra Tales']);
    expect(paginationOf(filtered).total).toBe(1);
  });

  it('never finds another reader’s wishes, even with identical words', async () => {
    const app = createAuthTestApp();
    const reader = await signInLibraryReader(app);
    const otherReader = await signInLibraryReader(app);
    await addWish(otherReader, { title: 'Arkenstone secret' });
    await addWish(reader, { title: 'My arkenstone' });

    expect(titlesOf(await reader.wishlist.list({ q: 'arkenstone' }))).toEqual(['My arkenstone']);
    expect(titlesOf(await otherReader.wishlist.list({ q: 'arkenstone' }))).toEqual([
      'Arkenstone secret',
    ]);
  });
});
