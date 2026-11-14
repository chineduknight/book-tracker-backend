import { describe, expect, it } from 'vitest';
import { WishlistItemModel } from '../../src/modules/wishlist/wishlist.model.js';
import { collectKeys, createAuthTestApp } from './auth-fixtures.js';
import {
  addWish,
  expectNotFound,
  invalidFieldsOf,
  signInLibraryReader,
  UNUSED_ID,
  wishFrom,
  wishesFrom,
} from './library-fixtures.js';

const OBJECT_ID = /^[0-9a-f]{24}$/;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const INTERNAL_KEYS = ['_id', '__v', 'ownerId', 'normalizedTitle', 'priorityRank', 'deletedAt'];
const DETAILED_WISH = {
  title: '  The   Left Hand of Darkness ',
  authors: [' Ursula K. Le Guin '],
  isbn: '978-0-441-47812-5',
  preferredFormat: 'physical',
  coverUrl: 'https://covers.example.test/left-hand.jpg',
  sourceUrl: 'https://shop.example.test/left-hand',
  priority: 'high',
  note: '  Gift idea for March  ',
};

function storedWish(id: string) {
  return WishlistItemModel.findById(id).orFail().lean();
}

describe('POST /api/v1/wishlist', () => {
  it('creates a minimal wanted item with defaults and exactly the public DTO', async () => {
    const reader = await signInLibraryReader(createAuthTestApp());

    const res = await reader.wishlist.create({ title: 'Dune' });

    expect(res.status).toBe(201);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toEqual({
      data: {
        id: expect.stringMatching(OBJECT_ID),
        title: 'Dune',
        authors: [],
        priority: 'medium',
        status: 'wanted',
        acquiredBookId: null,
        createdAt: expect.stringMatching(ISO_TIMESTAMP),
        updatedAt: expect.stringMatching(ISO_TIMESTAMP),
      },
    });
    expect(res.headers.location).toBe(`/api/v1/wishlist/${wishFrom(res).id}`);
    const keys = collectKeys(res.body);
    for (const internal of INTERNAL_KEYS) expect(keys.has(internal)).toBe(false);
    expect(await storedWish(wishFrom(res).id)).toMatchObject({
      normalizedTitle: 'dune',
      priorityRank: 1,
      acquiredBookId: null,
      deletedAt: null,
    });
    expect(await storedWish(wishFrom(res).id)).not.toHaveProperty('acquiredAt');
  });

  it.each(['physical', 'ebook'])('accepts a %s preference', async (preferredFormat) => {
    const reader = await signInLibraryReader(createAuthTestApp());

    const wish = await addWish(reader, { title: 'Dune', preferredFormat });

    expect(wish.preferredFormat).toBe(preferredFormat);
  });

  it('creates a detailed item, collapsing title whitespace and trimming the rest', async () => {
    const reader = await signInLibraryReader(createAuthTestApp());

    const wish = await addWish(reader, DETAILED_WISH);

    expect(wish).toMatchObject({
      title: 'The Left Hand of Darkness',
      authors: ['Ursula K. Le Guin'],
      isbn: '978-0-441-47812-5',
      preferredFormat: 'physical',
      coverUrl: 'https://covers.example.test/left-hand.jpg',
      sourceUrl: 'https://shop.example.test/left-hand',
      priority: 'high',
      note: 'Gift idea for March',
      status: 'wanted',
      acquiredBookId: null,
    });
    expect(await storedWish(wish.id)).toMatchObject({
      normalizedTitle: 'the left hand of darkness',
      priorityRank: 0,
    });
  });

  it('normalizes Unicode titles for the internal key but returns the title as typed', async () => {
    const reader = await signInLibraryReader(createAuthTestApp());

    const wish = await addWish(reader, { title: 'Café  SOCIETY' });

    expect(wish.title).toBe('Café SOCIETY');
    expect((await storedWish(wish.id)).normalizedTitle).toBe('café society');
  });

  it('allows duplicate titles and ISBNs, including ones already in the catalogue', async () => {
    const reader = await signInLibraryReader(createAuthTestApp());
    await reader.books.create({ title: 'Dune', format: 'physical', isbn: '9780441013593' });

    const first = await addWish(reader, { title: 'Dune', isbn: '9780441013593' });
    const second = await addWish(reader, { title: 'dune', isbn: '9780441013593' });

    expect(first.id).not.toBe(second.id);
    expect(wishesFrom(await reader.wishlist.list())).toHaveLength(2);
    expect((await reader.books.list()).body.meta.pagination.total).toBe(1);
  });

  it.each([
    ['a missing title', {}, ['title']],
    ['a blank title', { title: '  ' }, ['title']],
    ['a too long title', { title: 't'.repeat(251) }, ['title']],
    [
      'too many authors',
      { title: 'x', authors: Array.from({ length: 21 }, () => 'a') },
      ['authors'],
    ],
    ['a blank author', { title: 'x', authors: [' '] }, ['authors.0']],
    ['an ISBN without letters or digits', { title: 'x', isbn: '---' }, ['isbn']],
    ['an unknown format', { title: 'x', preferredFormat: 'audio' }, ['preferredFormat']],
    ['a non-http cover', { title: 'x', coverUrl: 'ftp://x.test/c.jpg' }, ['coverUrl']],
    ['a relative source URL', { title: 'x', sourceUrl: '/shop' }, ['sourceUrl']],
    ['an unknown priority', { title: 'x', priority: 'urgent' }, ['priority']],
    ['a blank note', { title: 'x', note: '' }, ['note']],
    ['a too long note', { title: 'x', note: 'n'.repeat(2_001) }, ['note']],
    ['a null title', { title: null }, ['title']],
    ['a client-set status', { title: 'x', status: 'acquired' }, ['status']],
    [
      'client-set acquisition',
      { title: 'x', acquiredBookId: UNUSED_ID, acquiredAt: 'now' },
      ['acquiredBookId', 'acquiredAt'],
    ],
    [
      'ownership and lifecycle fields',
      {
        title: 'x',
        ownerId: UNUSED_ID,
        bookId: UNUSED_ID,
        deletedAt: null,
        id: UNUSED_ID,
        createdAt: 'x',
      },
      ['ownerId', 'bookId', 'deletedAt', 'id', 'createdAt'],
    ],
  ])('rejects %s with 400 and stores nothing', async (_label, body, fields) => {
    const reader = await signInLibraryReader(createAuthTestApp());

    expect(invalidFieldsOf(await reader.wishlist.create(body))).toEqual(fields);
    expect(await WishlistItemModel.countDocuments()).toBe(0);
  });

  it('never echoes rejected content in the error response', async () => {
    const reader = await signInLibraryReader(createAuthTestApp());

    const res = await reader.wishlist.create({
      title: 'SECRET-WISH-MARKER'.repeat(20),
      note: 'SECRET-WISH-MARKER',
      sourceUrl: 'SECRET-WISH-MARKER',
    });

    expect(res.status).toBe(400);
    expect(res.text).not.toContain('SECRET-WISH-MARKER');
  });
});

describe('GET /api/v1/wishlist/:wishlistItemId', () => {
  it('returns the reader’s item and rejects a malformed id', async () => {
    const reader = await signInLibraryReader(createAuthTestApp());
    const wish = await addWish(reader, DETAILED_WISH);

    const res = await reader.wishlist.get(wish.id);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: wish });
    expect(invalidFieldsOf(await reader.wishlist.get('abc'))).toEqual(['wishlistItemId']);
  });

  it('responds identically for missing, foreign and deleted items', async () => {
    const app = createAuthTestApp();
    const reader = await signInLibraryReader(app);
    const otherReader = await signInLibraryReader(app);
    const foreign = await addWish(otherReader);
    const deleted = await addWish(reader);
    await reader.wishlist.remove(deleted.id);

    for (const id of [UNUSED_ID, foreign.id, deleted.id]) {
      expectNotFound(await reader.wishlist.get(id), 'Wishlist item not found');
    }
  });
});

describe('PATCH /api/v1/wishlist/:wishlistItemId', () => {
  it('changes only the given fields and keeps the normalized title and rank in step', async () => {
    const reader = await signInLibraryReader(createAuthTestApp());
    const wish = await addWish(reader, DETAILED_WISH);

    const res = await reader.wishlist.update(wish.id, {
      title: '  the LEFT  hand ',
      priority: 'low',
      authors: [],
    });

    expect(res.status).toBe(200);
    expect(wishFrom(res)).toEqual({
      ...wish,
      title: 'the LEFT hand',
      priority: 'low',
      authors: [],
      updatedAt: expect.stringMatching(ISO_TIMESTAMP),
    });
    expect(await storedWish(wish.id)).toMatchObject({
      normalizedTitle: 'the left hand',
      priorityRank: 2,
    });
  });

  it('clears optional fields with null and then omits them', async () => {
    const reader = await signInLibraryReader(createAuthTestApp());
    const wish = await addWish(reader, DETAILED_WISH);

    const res = await reader.wishlist.update(wish.id, {
      isbn: null,
      preferredFormat: null,
      coverUrl: null,
      sourceUrl: null,
      note: null,
    });

    expect(wishFrom(res)).toEqual({
      id: wish.id,
      title: wish.title,
      authors: wish.authors,
      priority: 'high',
      status: 'wanted',
      acquiredBookId: null,
      createdAt: wish.createdAt,
      updatedAt: expect.stringMatching(ISO_TIMESTAMP),
    });
    const stored = await storedWish(wish.id);
    for (const cleared of ['isbn', 'preferredFormat', 'coverUrl', 'sourceUrl', 'note']) {
      expect(stored).not.toHaveProperty(cleared);
    }
  });

  it.each([
    ['an empty body', {}, ['body']],
    ['a null title', { title: null }, ['title']],
    ['null authors', { authors: null }, ['authors']],
    ['a null priority', { priority: null }, ['priority']],
    ['a status change', { status: 'acquired' }, ['status']],
    [
      'acquisition fields',
      { acquiredBookId: UNUSED_ID, acquiredAt: null },
      ['acquiredBookId', 'acquiredAt'],
    ],
    [
      'internal fields',
      { title: 'x', normalizedTitle: 'x', priorityRank: 0, deletedAt: null },
      ['normalizedTitle', 'priorityRank', 'deletedAt'],
    ],
  ])('rejects %s with 400 and changes nothing', async (_label, changes, fields) => {
    const reader = await signInLibraryReader(createAuthTestApp());
    const wish = await addWish(reader, DETAILED_WISH);

    expect(invalidFieldsOf(await reader.wishlist.update(wish.id, changes))).toEqual(fields);
    expect((await reader.wishlist.get(wish.id)).body.data).toEqual(wish);
  });

  it('responds 404 for missing, foreign and deleted items and changes nothing', async () => {
    const app = createAuthTestApp();
    const reader = await signInLibraryReader(app);
    const otherReader = await signInLibraryReader(app);
    const foreign = await addWish(otherReader);
    const deleted = await addWish(reader);
    await reader.wishlist.remove(deleted.id);

    for (const id of [UNUSED_ID, foreign.id, deleted.id]) {
      expectNotFound(
        await reader.wishlist.update(id, { title: 'Hijacked' }),
        'Wishlist item not found',
      );
    }
    expect((await storedWish(foreign.id)).title).toBe('Dune');
    expect((await storedWish(deleted.id)).title).toBe('Dune');
  });
});

describe('DELETE /api/v1/wishlist/:wishlistItemId', () => {
  it('soft-deletes: 204 with no body, record kept, hidden from every endpoint afterwards', async () => {
    const reader = await signInLibraryReader(createAuthTestApp());
    const wish = await addWish(reader, DETAILED_WISH);
    const book = await reader.books.create({ title: 'Owned', format: 'ebook' });

    const res = await reader.wishlist.remove(wish.id);

    expect(res.status).toBe(204);
    expect(res.text).toBe('');
    expect(await storedWish(wish.id)).toMatchObject({
      title: 'The Left Hand of Darkness',
      note: 'Gift idea for March',
      deletedAt: expect.any(Date),
    });
    expectNotFound(await reader.wishlist.get(wish.id), 'Wishlist item not found');
    expectNotFound(
      await reader.wishlist.update(wish.id, { title: 'Back' }),
      'Wishlist item not found',
    );
    expectNotFound(await reader.wishlist.remove(wish.id), 'Wishlist item not found');
    expectNotFound(
      await reader.wishlist.acquire(wish.id, { bookId: book.body.data.id }),
      'Wishlist item not found',
    );
    for (const query of [
      {},
      { status: 'all' },
      { q: 'darkness', status: 'all' },
      { priority: 'high' },
    ]) {
      const list = await reader.wishlist.list(query);
      expect(list.body).toEqual({
        data: [],
        meta: { pagination: { page: 1, limit: 20, total: 0, totalPages: 0 } },
      });
    }
    expect(await storedWish(wish.id)).toMatchObject({ status: 'wanted', acquiredBookId: null });
  });

  it('responds 404 for a foreign item and leaves it untouched', async () => {
    const app = createAuthTestApp();
    const reader = await signInLibraryReader(app);
    const otherReader = await signInLibraryReader(app);
    const foreign = await addWish(otherReader);

    expectNotFound(await reader.wishlist.remove(foreign.id), 'Wishlist item not found');
    expect((await storedWish(foreign.id)).deletedAt).toBeNull();
  });
});
