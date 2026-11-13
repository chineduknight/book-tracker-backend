import request from 'supertest';
import { describe, expect, it } from 'vitest';
import {
  createCopyRequestSchema,
  listCopiesQuerySchema,
  updateCopyRequestSchema,
} from '../src/modules/copies/copy.schema.js';
import { updateBookRequestSchema } from '../src/modules/books/book.schema.js';
import {
  createLocationRequestSchema,
  listLocationsQuerySchema,
  updateLocationRequestSchema,
} from '../src/modules/locations/location.schema.js';
import { ALLOWED_ORIGIN, createTestApp } from './helpers.js';

const SOME_ID = '64b7f0c2a1b2c3d4e5f60718';

describe('location request schemas', () => {
  it('trims and collapses names and trims descriptions', () => {
    expect(
      createLocationRequestSchema.parse({ name: '  Study \t Shelf ', description: ' Left wall ' }),
    ).toEqual({ name: 'Study Shelf', description: 'Left wall' });
  });

  it.each<[string, object]>([
    ['a blank name', { name: '   ' }],
    ['a name over 100 characters', { name: 'n'.repeat(101) }],
    ['a blank description', { name: 'Home', description: ' ' }],
    ['a description over 500 characters', { name: 'Home', description: 'd'.repeat(501) }],
    ['a null description', { name: 'Home', description: null }],
    ['an owner field', { name: 'Home', ownerId: SOME_ID }],
    ['a normalized name', { name: 'Home', normalizedName: 'home' }],
  ])('rejects %s on create', (_label, body) => {
    expect(createLocationRequestSchema.safeParse(body).success).toBe(false);
  });

  it('allows clearing the description and rejects empty or null-name updates', () => {
    expect(updateLocationRequestSchema.parse({ description: null })).toEqual({ description: null });
    expect(updateLocationRequestSchema.safeParse({}).success).toBe(false);
    expect(updateLocationRequestSchema.safeParse({ name: null }).success).toBe(false);
  });

  it('accepts only page and limit when listing', () => {
    expect(listLocationsQuerySchema.parse({})).toEqual({ page: 1, limit: 20 });
    expect(listLocationsQuerySchema.safeParse({ sort: 'name' }).success).toBe(false);
    expect(listLocationsQuerySchema.safeParse({ limit: '101' }).success).toBe(false);
  });
});

describe('physical copy request schemas', () => {
  it('accepts an empty or missing body on create', () => {
    expect(createCopyRequestSchema.parse({})).toEqual({});
    expect(createCopyRequestSchema.parse(undefined)).toEqual({});
  });

  it('accepts an explicit null location on create', () => {
    expect(createCopyRequestSchema.parse({ locationId: null, condition: 'like_new' })).toEqual({
      locationId: null,
      condition: 'like_new',
    });
  });

  it.each(['ownerId', 'userId', 'bookId', '_id', 'deletedAt', 'isOnLoan', 'isAvailable', 'role'])(
    'rejects the field %s on create and update',
    (field) => {
      expect(createCopyRequestSchema.safeParse({ [field]: 'x' }).success).toBe(false);
      expect(updateCopyRequestSchema.safeParse({ label: 'Copy 1', [field]: 'x' }).success).toBe(
        false,
      );
    },
  );

  it.each<[string, object]>([
    ['a blank label', { label: '  ' }],
    ['a label over 100 characters', { label: 'l'.repeat(101) }],
    ['an unknown condition', { condition: 'mint' }],
    ['a blank storage note', { storageNote: ' ' }],
    ['a storage note over 500 characters', { storageNote: 's'.repeat(501) }],
    ['a malformed location id', { locationId: 'home' }],
    ['a location id given as an object', { locationId: { $ne: null } }],
  ])('rejects %s', (_label, body) => {
    expect(createCopyRequestSchema.safeParse(body).success).toBe(false);
  });

  it('lets updates clear every optional field and rejects an empty update', () => {
    const changes = { locationId: null, label: null, condition: null, storageNote: null };

    expect(updateCopyRequestSchema.parse(changes)).toEqual(changes);
    expect(updateCopyRequestSchema.safeParse({}).success).toBe(false);
  });

  it('validates copy list filters', () => {
    expect(listCopiesQuerySchema.parse({ locationId: SOME_ID, condition: 'good' })).toEqual({
      page: 1,
      limit: 20,
      locationId: SOME_ID,
      condition: 'good',
    });
    for (const query of [
      { locationId: 'home' },
      { locationId: [SOME_ID, SOME_ID] },
      { condition: 'mint' },
      { sort: 'oldest' },
    ]) {
      expect(listCopiesQuerySchema.safeParse(query).success).toBe(false);
    }
  });
});

describe('update schemas', () => {
  it.each([
    ['book', updateBookRequestSchema, 'ownerId'],
    ['location', updateLocationRequestSchema, 'ownerId'],
    ['copy', updateCopyRequestSchema, 'bookId'],
  ] as const)('report only the unknown field for a %s update', (_label, schema, field) => {
    const result = schema.safeParse({ [field]: SOME_ID });

    expect(result.error?.issues).toEqual([
      expect.objectContaining({ code: 'unrecognized_keys', keys: [field] }),
    ]);
  });
});

describe('copy and location endpoints without authentication', () => {
  it.each([
    ['POST', '/api/v1/locations'],
    ['GET', '/api/v1/locations'],
    ['GET', `/api/v1/locations/${SOME_ID}`],
    ['PATCH', `/api/v1/locations/${SOME_ID}`],
    ['POST', `/api/v1/books/${SOME_ID}/copies`],
    ['GET', `/api/v1/books/${SOME_ID}/copies`],
    ['GET', `/api/v1/copies/${SOME_ID}`],
    ['PATCH', `/api/v1/copies/${SOME_ID}`],
    ['DELETE', `/api/v1/copies/${SOME_ID}`],
  ])('%s %s returns 401 UNAUTHENTICATED without caching', async (method, path) => {
    const res = await request(createTestApp())[method.toLowerCase() as 'get'](path).send({});

    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toBe('Bearer');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });
});

describe('private data responses', () => {
  it.each(['/api/v1/books', '/api/v1/copies/x', '/api/v1/locations'])(
    'sends no-store on %s even when the body parser rejects the request',
    async (path) => {
      const res = await request(createTestApp())
        .post(path)
        .set('Content-Type', 'application/json')
        .send('{"name": ');

      expect(res.status).toBe(400);
      expect(res.headers['cache-control']).toBe('no-store');
    },
  );

  it('lets browsers read the Location header of created resources', async () => {
    const res = await request(createTestApp()).get('/api/v1/health').set('Origin', ALLOWED_ORIGIN);

    expect(res.headers['access-control-expose-headers']).toBe('x-request-id,Location');
  });
});
