import { Types } from 'mongoose';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { toPublicWishlistItem } from '../src/modules/wishlist/wishlist.dto.js';
import type { WishlistItemRecord } from '../src/modules/wishlist/wishlist.model.js';
import { normalizeWishTitle, priorityRankOf } from '../src/modules/wishlist/wishlist.rules.js';
import {
  acquireWishlistItemRequestSchema,
  createWishlistItemRequestSchema,
  listWishlistQuerySchema,
  updateWishlistItemRequestSchema,
} from '../src/modules/wishlist/wishlist.schema.js';
import { toTextSearchWords } from '../src/shared/text.js';
import { createTestApp } from './helpers.js';

const SOME_ID = '64b7f0c2a1b2c3d4e5f60718';

function firstInvalidField(result: { success: boolean; error?: { issues: object[] } }) {
  const issue = result.error?.issues[0] as
    { code: string; path: PropertyKey[]; keys?: string[] } | undefined;
  return issue?.code === 'unrecognized_keys' ? issue.keys?.[0] : issue?.path.join('.');
}

describe('wishlist rules', () => {
  it('ranks high before medium before low', () => {
    expect([priorityRankOf('high'), priorityRankOf('medium'), priorityRankOf('low')]).toEqual([
      0, 1, 2,
    ]);
  });

  it('normalizes titles like the catalogue does', () => {
    expect(normalizeWishTitle('  The   LEFT Hand ')).toBe('the left hand');
    expect(normalizeWishTitle('Café')).toBe('café');
  });

  it('neutralizes search operators with the shared helper', () => {
    expect(toTextSearchWords(' "dune" -herbert ')).toBe('dune herbert');
  });
});

describe('createWishlistItemRequestSchema', () => {
  it('fills defaults for authors and priority, never status or acquisition', () => {
    expect(createWishlistItemRequestSchema.parse({ title: ' Dune ' })).toEqual({
      title: 'Dune',
      authors: [],
      priority: 'medium',
    });
  });

  it('collapses the title and trims authors, ISBN, URLs and note', () => {
    expect(
      createWishlistItemRequestSchema.parse({
        title: ' The   Dispossessed ',
        authors: [' Le Guin '],
        isbn: ' 978-0-06-051275-9 ',
        preferredFormat: 'ebook',
        coverUrl: ' https://covers.example.test/d.jpg ',
        sourceUrl: 'http://shop.example.test/d',
        priority: 'high',
        note: ' paperback  only ',
      }),
    ).toEqual({
      title: 'The Dispossessed',
      authors: ['Le Guin'],
      isbn: '978-0-06-051275-9',
      preferredFormat: 'ebook',
      coverUrl: 'https://covers.example.test/d.jpg',
      sourceUrl: 'http://shop.example.test/d',
      priority: 'high',
      note: 'paperback  only',
    });
  });

  it.each([
    [{}, 'title'],
    [{ title: 'x', status: 'wanted' }, 'status'],
    [{ title: 'x', acquiredBookId: null }, 'acquiredBookId'],
    [{ title: 'x', acquiredAt: '2026-01-01T00:00:00.000Z' }, 'acquiredAt'],
    [{ title: 'x', ownerId: SOME_ID }, 'ownerId'],
    [{ title: 'x', bookId: SOME_ID }, 'bookId'],
    [{ title: 'x', priority: 'urgent' }, 'priority'],
    [{ title: 'x', preferredFormat: 'audiobook' }, 'preferredFormat'],
    [{ title: 'x', coverUrl: 'javascript:alert(1)' }, 'coverUrl'],
    [{ title: 'x', sourceUrl: 'https://' + 'x'.repeat(2_048) }, 'sourceUrl'],
    [{ title: 'x', authors: 'Herbert' }, 'authors'],
    [{ title: 'x', note: null }, 'note'],
  ])('rejects %j', (body, field) => {
    expect(firstInvalidField(createWishlistItemRequestSchema.safeParse(body))).toBe(field);
  });
});

describe('updateWishlistItemRequestSchema', () => {
  it('accepts partial changes, empty authors and null for clearable fields', () => {
    expect(updateWishlistItemRequestSchema.parse({ authors: [], isbn: null, note: null })).toEqual({
      authors: [],
      isbn: null,
      note: null,
    });
    expect(
      updateWishlistItemRequestSchema.parse({
        preferredFormat: null,
        coverUrl: null,
        sourceUrl: null,
      }),
    ).toEqual({ preferredFormat: null, coverUrl: null, sourceUrl: null });
  });

  it.each([
    [{}, 'body'],
    [{ title: null }, 'title'],
    [{ priority: null }, 'priority'],
    [{ authors: null }, 'authors'],
    [{ status: 'acquired' }, 'status'],
    [{ acquiredBookId: SOME_ID }, 'acquiredBookId'],
    [{ acquiredAt: null }, 'acquiredAt'],
    [{ deletedAt: null }, 'deletedAt'],
  ])('rejects %j', (changes, field) => {
    const result = updateWishlistItemRequestSchema.safeParse(changes);

    expect(result.success).toBe(false);
    expect(firstInvalidField(result) || 'body').toBe(field);
  });
});

describe('acquireWishlistItemRequestSchema', () => {
  it('accepts exactly a well-formed bookId', () => {
    expect(acquireWishlistItemRequestSchema.parse({ bookId: SOME_ID })).toEqual({
      bookId: SOME_ID,
    });
    for (const body of [
      {},
      { bookId: 'x' },
      { bookId: SOME_ID, acquiredAt: 'now' },
      { bookId: null },
    ]) {
      expect(acquireWishlistItemRequestSchema.safeParse(body).success).toBe(false);
    }
  });
});

describe('listWishlistQuerySchema', () => {
  it('defaults to the first page of 20 wanted items, newest first', () => {
    expect(listWishlistQuerySchema.parse({})).toEqual({
      page: 1,
      limit: 20,
      status: 'wanted',
      sort: 'recent',
    });
  });

  it('accepts every documented filter and sort', () => {
    expect(
      listWishlistQuerySchema.parse({
        status: 'all',
        priority: 'low',
        q: ' dune ',
        sort: 'priority',
      }),
    ).toMatchObject({ status: 'all', priority: 'low', q: 'dune', sort: 'priority' });
  });

  it.each([
    { status: 'deleted' },
    { status: ['wanted', 'all'] },
    { priority: 'urgent' },
    { sort: 'relevance' },
    { q: '' },
    { q: '--' },
    { page: '0' },
    { limit: '101' },
    { format: 'ebook' },
  ])('rejects %j', (query) => {
    expect(listWishlistQuerySchema.safeParse(query).success).toBe(false);
  });
});

describe('toPublicWishlistItem', () => {
  const timestamp = new Date('2026-11-14T10:30:00.000Z');
  const wanted = {
    _id: new Types.ObjectId(SOME_ID),
    ownerId: new Types.ObjectId(),
    title: 'Dune',
    normalizedTitle: 'dune',
    authors: ['Herbert'],
    priority: 'medium',
    priorityRank: 1,
    status: 'wanted',
    acquiredBookId: null,
    deletedAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  } as unknown as WishlistItemRecord;

  it('exposes exactly the public keys of a wanted item', () => {
    expect(toPublicWishlistItem(wanted)).toEqual({
      id: SOME_ID,
      title: 'Dune',
      authors: ['Herbert'],
      priority: 'medium',
      status: 'wanted',
      acquiredBookId: null,
      createdAt: '2026-11-14T10:30:00.000Z',
      updatedAt: '2026-11-14T10:30:00.000Z',
    });
  });

  it('includes the acquisition and optional fields when set, never internals', () => {
    const bookId = new Types.ObjectId();

    const dto = toPublicWishlistItem({
      ...wanted,
      isbn: '1',
      preferredFormat: 'ebook',
      coverUrl: 'https://c.test/x',
      sourceUrl: 'https://s.test/x',
      note: 'n',
      status: 'acquired',
      acquiredBookId: bookId,
      acquiredAt: timestamp,
      deletedAt: timestamp,
    });

    expect(dto).toMatchObject({
      status: 'acquired',
      acquiredBookId: bookId.toHexString(),
      acquiredAt: '2026-11-14T10:30:00.000Z',
      preferredFormat: 'ebook',
    });
    for (const internal of ['ownerId', 'normalizedTitle', 'priorityRank', 'deletedAt', '_id']) {
      expect(dto).not.toHaveProperty(internal);
    }
  });
});

describe('wishlist endpoints without authentication', () => {
  it.each([
    ['POST', '/api/v1/wishlist'],
    ['GET', '/api/v1/wishlist'],
    ['GET', `/api/v1/wishlist/${SOME_ID}`],
    ['PATCH', `/api/v1/wishlist/${SOME_ID}`],
    ['PUT', `/api/v1/wishlist/${SOME_ID}/acquisition`],
    ['DELETE', `/api/v1/wishlist/${SOME_ID}`],
  ])('%s %s returns 401 UNAUTHENTICATED without caching', async (method, path) => {
    const res = await request(createTestApp())[method.toLowerCase() as 'get'](path).send({});

    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toBe('Bearer');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('sends no-store for malformed bodies and CORS preflight', async () => {
    const app = createTestApp();

    const malformed = await request(app)
      .post('/api/v1/wishlist')
      .set('Content-Type', 'application/json')
      .send('{"title": ');
    const preflight = await request(app)
      .options('/api/v1/wishlist')
      .set('Origin', 'http://localhost:5173')
      .set('Access-Control-Request-Method', 'PUT');

    expect(malformed.status).toBe(400);
    expect(preflight.status).toBe(204);
    expect(malformed.headers['cache-control']).toBe('no-store');
    expect(preflight.headers['cache-control']).toBe('no-store');
  });
});
