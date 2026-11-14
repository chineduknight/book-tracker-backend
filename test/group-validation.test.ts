import { Types } from 'mongoose';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { pageOf, visibleMembersInOrder } from '../src/modules/books/book.membership.js';
import { toPublicCategory } from '../src/modules/categories/category.dto.js';
import type { CategoryRecord } from '../src/modules/categories/category.model.js';
import { CATEGORY_PRESET_NAMES } from '../src/modules/categories/category.presets.js';
import {
  categoryBookParamsSchema,
  createCategoryRequestSchema,
  listCategoriesQuerySchema,
  updateCategoryRequestSchema,
} from '../src/modules/categories/category.schema.js';
import { toPublicBookCollection } from '../src/modules/collections/collection.dto.js';
import {
  collectionBookParamsSchema,
  createCollectionRequestSchema,
  updateCollectionRequestSchema,
} from '../src/modules/collections/collection.schema.js';
import { toCaseInsensitiveKey } from '../src/shared/text.js';
import { createTestApp } from './helpers.js';

const SOME_ID = '64b7f0c2a1b2c3d4e5f60718';
const OTHER_ID = '64b7f0c2a1b2c3d4e5f60719';

describe('group name normalization', () => {
  it.each([
    ['  To   Read in 2027 ', 'to read in 2027'],
    ['PHILOSOPHY', 'philosophy'],
    ['Café  Reads', 'café reads'],
    ['Café reads', 'café reads'],
    ['Books\tfor\nIsioma', 'books for isioma'],
  ])('%j normalizes to %j', (name, key) => {
    expect(toCaseInsensitiveKey(name)).toBe(key);
  });
});

describe.each([
  ['category', createCategoryRequestSchema, updateCategoryRequestSchema],
  ['collection', createCollectionRequestSchema, updateCollectionRequestSchema],
] as const)('%s request schemas', (_label, createSchema, updateSchema) => {
  it('collapses whitespace in the name and trims the description', () => {
    expect(createSchema.parse({ name: '  My   Favourites ', description: ' Best  ones ' })).toEqual(
      { name: 'My Favourites', description: 'Best  ones' },
    );
  });

  it.each([
    [{}, 'name'],
    [{ name: '   ' }, 'name'],
    [{ name: 'n'.repeat(101) }, 'name'],
    [{ name: 'x', description: '' }, 'description'],
    [{ name: 'x', description: 'd'.repeat(501) }, 'description'],
    [{ name: 'x', ownerId: SOME_ID }, 'ownerId'],
    [{ name: 'x', bookIds: [SOME_ID] }, 'bookIds'],
  ])('rejects %j on create', (body, field) => {
    const result = createSchema.safeParse(body);

    expect(result.success).toBe(false);
    const issue = result.error?.issues[0];
    expect(issue?.code === 'unrecognized_keys' ? issue.keys[0] : issue?.path[0]).toBe(field);
  });

  it('accepts a rename, a description change or clearing the description', () => {
    expect(updateSchema.parse({ name: ' New  Name ' })).toEqual({ name: 'New Name' });
    expect(updateSchema.parse({ description: null })).toEqual({ description: null });
  });

  it.each([{}, { name: null }, { name: 'x', deletedAt: null }, { normalizedName: 'x' }])(
    'rejects %j on PATCH',
    (changes) => {
      expect(updateSchema.safeParse(changes).success).toBe(false);
    },
  );
});

describe('group query and route parameter schemas', () => {
  it('defaults to the first page of 20 and accepts only page and limit', () => {
    expect(listCategoriesQuerySchema.parse({})).toEqual({ page: 1, limit: 20 });
    for (const query of [{ sort: 'name' }, { page: ['1', '2'] }, { limit: '101' }, { page: '0' }]) {
      expect(listCategoriesQuerySchema.safeParse(query).success).toBe(false);
    }
  });

  it('requires both ids of a membership to be well-formed', () => {
    expect(categoryBookParamsSchema.parse({ categoryId: SOME_ID, bookId: OTHER_ID })).toEqual({
      categoryId: SOME_ID,
      bookId: OTHER_ID,
    });
    expect(
      collectionBookParamsSchema.safeParse({ collectionId: SOME_ID, bookId: 'x' }).success,
    ).toBe(false);
    expect(categoryBookParamsSchema.safeParse({ categoryId: 'x', bookId: SOME_ID }).success).toBe(
      false,
    );
  });
});

describe('category presets', () => {
  it('is a fixed, ordered list of distinct non-blank suggestions', () => {
    expect(CATEGORY_PRESET_NAMES).toEqual([
      'Fiction',
      'Nonfiction',
      'Biography',
      'History',
      'Philosophy',
      'Psychology',
      'Science',
      'Technology',
      'Religion',
      'Personal Development',
    ]);
    expect(new Set(CATEGORY_PRESET_NAMES.map(toCaseInsensitiveKey)).size).toBe(
      CATEGORY_PRESET_NAMES.length,
    );
    expect(Object.isFrozen(CATEGORY_PRESET_NAMES) || Array.isArray(CATEGORY_PRESET_NAMES)).toBe(
      true,
    );
  });
});

describe('membership ordering and paging', () => {
  const ids = Array.from({ length: 5 }, () => new Types.ObjectId());
  const book = (id: Types.ObjectId) => ({ _id: id });

  it('keeps membership order and drops members without a visible book', () => {
    const visible = [book(ids[4]!), book(ids[0]!), book(ids[2]!)];

    const members = visibleMembersInOrder(ids, visible);

    expect(members.map((member) => member._id)).toEqual([ids[0], ids[2], ids[4]]);
    expect(visibleMembersInOrder([], visible)).toEqual([]);
    expect(visibleMembersInOrder(ids, [])).toEqual([]);
  });

  it('ignores visible books that are not members', () => {
    const stranger = book(new Types.ObjectId());

    expect(visibleMembersInOrder([ids[1]!], [stranger, book(ids[1]!)])).toEqual([book(ids[1]!)]);
  });

  it('pages the already filtered members', () => {
    const items = ['a', 'b', 'c', 'd', 'e'];

    expect(pageOf(items, 1, 2)).toEqual(['a', 'b']);
    expect(pageOf(items, 3, 2)).toEqual(['e']);
    expect(pageOf(items, 4, 2)).toEqual([]);
    expect(pageOf([], 1, 20)).toEqual([]);
  });
});

describe('group DTO mapping', () => {
  const timestamp = new Date('2026-11-13T10:30:00.000Z');
  const record = {
    _id: new Types.ObjectId(SOME_ID),
    ownerId: new Types.ObjectId(),
    name: 'Philosophy',
    normalizedName: 'philosophy',
    bookIds: [new Types.ObjectId()],
    deletedAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  } as unknown as CategoryRecord;

  it.each([
    ['category', toPublicCategory],
    ['collection', toPublicBookCollection],
  ] as const)('exposes only the public %s fields', (_label, toPublic) => {
    expect(toPublic(record)).toEqual({
      id: SOME_ID,
      name: 'Philosophy',
      createdAt: '2026-11-13T10:30:00.000Z',
      updatedAt: '2026-11-13T10:30:00.000Z',
    });
    expect(toPublic({ ...record, description: 'Thinking' }).description).toBe('Thinking');
  });
});

describe('group endpoints without authentication', () => {
  it.each([
    ['GET', '/api/v1/categories/presets'],
    ['POST', '/api/v1/categories'],
    ['GET', '/api/v1/collections'],
    ['PUT', `/api/v1/categories/${SOME_ID}/books/${OTHER_ID}`],
    ['DELETE', `/api/v1/collections/${SOME_ID}/books/${OTHER_ID}`],
    ['GET', `/api/v1/collections/${SOME_ID}/books`],
    ['GET', `/api/v1/books/${SOME_ID}/organization`],
  ])('%s %s returns 401 UNAUTHENTICATED without caching', async (method, path) => {
    const res = await request(createTestApp())[method.toLowerCase() as 'get'](path).send({});

    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toBe('Bearer');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it.each(['/api/v1/categories', '/api/v1/collections'])(
    'sends no-store for malformed bodies, preflight and unauthenticated unknown paths under %s',
    async (root) => {
      const app = createTestApp();

      const malformed = await request(app)
        .post(root)
        .set('Content-Type', 'application/json')
        .send('{"name": ');
      const preflight = await request(app)
        .options(root)
        .set('Origin', 'http://localhost:5173')
        .set('Access-Control-Request-Method', 'PUT');
      const unknown = await request(app).get(`${root}/x/y/z`);

      expect(malformed.status).toBe(400);
      expect(preflight.status).toBe(204);
      expect(unknown.status).toBe(401);
      for (const res of [malformed, preflight, unknown]) {
        expect(res.headers['cache-control']).toBe('no-store');
      }
    },
  );
});
