import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { LocationModel } from '../../src/modules/locations/location.model.js';
import { bearer, createAuthTestApp } from './auth-fixtures.js';
import {
  addLocation,
  expectNotFound,
  LOCATION_DTO_KEYS,
  locationFrom,
  locationsFrom,
  paginationOf,
  signInLibraryReader,
  UNUSED_ID,
} from './library-fixtures.js';

const OBJECT_ID_HEX = /^[0-9a-f]{24}$/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

describe('POST /api/v1/locations', () => {
  it('creates a location with only public fields and a Location header', async () => {
    const reader = await signInLibraryReader(createAuthTestApp());

    const res = await reader.locations.create({
      name: '  Study   Shelf ',
      description: ' Left of the window ',
    });

    expect(res.status).toBe(201);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toEqual({
      data: {
        id: expect.stringMatching(OBJECT_ID_HEX),
        name: 'Study Shelf',
        description: 'Left of the window',
        createdAt: expect.stringMatching(ISO_UTC),
        updatedAt: expect.stringMatching(ISO_UTC),
      },
    });
    expect(Object.keys(locationFrom(res)).sort()).toEqual([...LOCATION_DTO_KEYS].sort());
    expect(res.headers.location).toBe(`/api/v1/locations/${locationFrom(res).id}`);
    for (const internal of ['ownerId', 'normalizedName', '_id', '__v']) {
      expect(res.text).not.toContain(internal);
    }
  });

  it('omits an unset description', async () => {
    const reader = await signInLibraryReader(createAuthTestApp());

    const location = await addLocation(reader, 'Home');

    expect(location).not.toHaveProperty('description');
  });

  it('lets two readers each have a location called Home', async () => {
    const app = createAuthTestApp();
    const jane = await signInLibraryReader(app);
    const omar = await signInLibraryReader(app);

    const janesHome = await addLocation(jane, 'Home');
    const omarsHome = await addLocation(omar, 'Home');

    expect(janesHome.id).not.toBe(omarsHome.id);
  });

  it.each(['home', ' Home ', 'HOME', '  hOmE  '])(
    'rejects %j when the reader already has Home',
    async (duplicate) => {
      const reader = await signInLibraryReader(createAuthTestApp());
      await addLocation(reader, 'Home');

      const res = await reader.locations.create({ name: duplicate });

      expect(res.status).toBe(409);
      expect(res.body).toEqual({
        error: {
          code: 'CONFLICT',
          message: 'A location with this name already exists',
          requestId: res.headers['x-request-id'],
        },
      });
    },
  );

  it('treats composed and decomposed accents as the same name', async () => {
    const reader = await signInLibraryReader(createAuthTestApp());
    await addLocation(reader, 'Caf\u00e9');

    expect((await reader.locations.create({ name: 'Cafe\u0301' })).status).toBe(409);
  });

  it('lets the unique index decide concurrent creates of the same name', async () => {
    const reader = await signInLibraryReader(createAuthTestApp());

    const responses = await Promise.all(
      ['Home', 'home', ' HOME ', 'Home', 'hOME'].map((name) => reader.locations.create({ name })),
    );

    expect(responses.map((res) => res.status).sort()).toEqual([201, 409, 409, 409, 409]);
    expect(await LocationModel.countDocuments()).toBe(1);
  });
});

describe('PATCH /api/v1/locations/:locationId', () => {
  it('renames, allows a case-only rename and clears the description', async () => {
    const reader = await signInLibraryReader(createAuthTestApp());
    const location = await addLocation(reader, 'study shelf', 'Left wall');

    const caseOnly = await reader.locations.update(location.id, { name: 'Study Shelf' });
    const cleared = await reader.locations.update(location.id, { description: null });

    expect(caseOnly.status).toBe(200);
    expect(locationFrom(caseOnly)).toMatchObject({ name: 'Study Shelf', description: 'Left wall' });
    expect(locationFrom(cleared)).toEqual({
      id: location.id,
      name: 'Study Shelf',
      createdAt: location.createdAt,
      updatedAt: expect.stringMatching(ISO_UTC),
    });
  });

  it('rejects renaming to another location’s name, including concurrently', async () => {
    const reader = await signInLibraryReader(createAuthTestApp());
    await addLocation(reader, 'Home');
    const office = await addLocation(reader, 'Office');
    const attic = await addLocation(reader, 'Attic');

    const direct = await reader.locations.update(office.id, { name: ' HOME ' });
    const racing = await Promise.all([
      reader.locations.update(office.id, { name: 'Garage' }),
      reader.locations.update(attic.id, { name: 'garage' }),
    ]);

    expect(direct.status).toBe(409);
    expect(direct.body.error.code).toBe('CONFLICT');
    expect(racing.map((res) => res.status).sort()).toEqual([200, 409]);
    expect(await LocationModel.countDocuments({ normalizedName: 'garage' })).toBe(1);
  });

  it.each<[string, object]>([
    ['an empty change set', {}],
    ['a null name', { name: null }],
    ['an owner field', { ownerId: UNUSED_ID }],
  ])('rejects %s', async (_label, changes) => {
    const reader = await signInLibraryReader(createAuthTestApp());
    const location = await addLocation(reader, 'Home');

    const res = await reader.locations.update(location.id, changes);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('GET /api/v1/locations', () => {
  it('returns an empty first page for a new reader', async () => {
    const reader = await signInLibraryReader(createAuthTestApp());

    expect((await reader.locations.list()).body).toEqual({
      data: [],
      meta: { pagination: { page: 1, limit: 20, total: 0, totalPages: 0 } },
    });
  });

  it('lists only the reader’s locations alphabetically across pages', async () => {
    const app = createAuthTestApp();
    const reader = await signInLibraryReader(app);
    const other = await signInLibraryReader(app);
    for (const name of ['office', 'Attic', 'garage', 'Basement', 'home']) {
      await addLocation(reader, name);
    }
    await addLocation(other, 'Annex');

    const first = await reader.locations.list({ limit: '3' });
    const second = await reader.locations.list({ page: '2', limit: '3' });

    expect(locationsFrom(first).map((location) => location.name)).toEqual([
      'Attic',
      'Basement',
      'garage',
    ]);
    expect(locationsFrom(second).map((location) => location.name)).toEqual(['home', 'office']);
    expect(paginationOf(second)).toEqual({ page: 2, limit: 3, total: 5, totalPages: 2 });
  });

  it.each([['sort=name'], ['limit=0'], ['page=1&page=2'], ['ownerId=x']])(
    'rejects ?%s',
    async (query) => {
      const reader = await signInLibraryReader(createAuthTestApp());

      const res = await reader.locations.list(query);

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    },
  );
});

describe('GET /api/v1/locations/:locationId', () => {
  it('returns the reader’s location', async () => {
    const reader = await signInLibraryReader(createAuthTestApp());
    const location = await addLocation(reader, 'Home', 'Living room');

    const res = await reader.locations.get(location.id);

    expect(res.body).toEqual({ data: location });
  });

  it('hides another reader’s location behind the same 404 as a missing one', async () => {
    const app = createAuthTestApp();
    const jane = await signInLibraryReader(app);
    const omar = await signInLibraryReader(app);
    const janesHome = await addLocation(jane, 'Home');

    expectNotFound(await omar.locations.get(janesHome.id), 'Location not found');
    expectNotFound(await omar.locations.get(UNUSED_ID), 'Location not found');
    expectNotFound(
      await omar.locations.update(janesHome.id, { name: 'Mine' }),
      'Location not found',
    );
    expect((await jane.locations.get(janesHome.id)).body.data.name).toBe('Home');
  });

  it('rejects a malformed id', async () => {
    const reader = await signInLibraryReader(createAuthTestApp());

    const res = await reader.locations.get('home');

    expect(res.status).toBe(400);
    expect(res.body.error.details).toEqual([
      { field: 'locationId', message: 'must be a 24-character hexadecimal id' },
    ]);
  });

  it('has no delete endpoint and keeps the location', async () => {
    const app = createAuthTestApp();
    const reader = await signInLibraryReader(app);
    const location = await addLocation(reader, 'Home');

    const res = await request(app)
      .delete(`/api/v1/locations/${location.id}`)
      .set('Authorization', bearer(reader.tokens.accessToken));

    expectNotFound(res, 'Route not found');
    expect((await reader.locations.get(location.id)).status).toBe(200);
  });
});
