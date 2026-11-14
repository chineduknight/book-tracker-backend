import { describe, expect, it } from 'vitest';
import { CategoryModel } from '../../src/modules/categories/category.model.js';
import { CATEGORY_PRESET_NAMES } from '../../src/modules/categories/category.presets.js';
import { BookCollectionModel } from '../../src/modules/collections/collection.model.js';
import { collectKeys, createAuthTestApp } from './auth-fixtures.js';
import {
  addGroup,
  addPhysicalBook,
  expectNotFound,
  GROUP_KINDS,
  groupFrom,
  groupsFrom,
  invalidFieldsOf,
  paginationOf,
  putBookInGroup,
  signInLibraryReader,
  UNUSED_ID,
  type GroupKind,
} from './library-fixtures.js';

const OBJECT_ID = /^[0-9a-f]{24}$/;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const INTERNAL_KEYS = ['_id', '__v', 'ownerId', 'normalizedName', 'bookIds', 'deletedAt'];
const MODELS = { categories: CategoryModel, collections: BookCollectionModel } as const;

async function signInWithGroups(kind: GroupKind) {
  const reader = await signInLibraryReader(createAuthTestApp());
  return { reader, groups: reader[kind] };
}

describe('GET /api/v1/categories/presets', () => {
  it('returns the fixed suggestion list without creating categories', async () => {
    const reader = await signInLibraryReader(createAuthTestApp());

    const res = await reader.presets();

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toEqual({ data: { names: [...CATEGORY_PRESET_NAMES] } });
    expect(res.body.data.names[0]).toBe('Fiction');
    expect(await CategoryModel.countDocuments()).toBe(0);
    expect((await reader.categories.list()).body.data).toEqual([]);
  });

  it('keeps suggesting a preset the reader already created or deleted', async () => {
    const reader = await signInLibraryReader(createAuthTestApp());
    const philosophy = await addGroup(reader.categories, 'Philosophy');
    await reader.categories.remove(philosophy.id);
    await addGroup(reader.categories, 'History');

    expect((await reader.presets()).body.data.names).toEqual([...CATEGORY_PRESET_NAMES]);
    expect(await CategoryModel.countDocuments()).toBe(2);
  });
});

describe.each(GROUP_KINDS)('%s endpoints', (label, kind, notFoundMessage) => {
  it('starts every reader with no groups', async () => {
    const { groups } = await signInWithGroups(kind);

    expect((await groups.list()).body).toEqual({
      data: [],
      meta: { pagination: { page: 1, limit: 20, total: 0, totalPages: 0 } },
    });
    expect(await MODELS[kind].countDocuments()).toBe(0);
  });

  it(`creates a ${label} with only public fields and a Location header`, async () => {
    const { groups } = await signInWithGroups(kind);

    const res = await groups.create({ name: '  To   Read in 2027 ', description: ' Big ones ' });

    expect(res.status).toBe(201);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toEqual({
      data: {
        id: expect.stringMatching(OBJECT_ID),
        name: 'To Read in 2027',
        description: 'Big ones',
        createdAt: expect.stringMatching(ISO_TIMESTAMP),
        updatedAt: expect.stringMatching(ISO_TIMESTAMP),
      },
    });
    expect(res.headers.location).toBe(`/api/v1/${kind}/${groupFrom(res).id}`);
    const keys = collectKeys(res.body);
    for (const internalKey of INTERNAL_KEYS) expect(keys.has(internalKey)).toBe(false);
    expect(await MODELS[kind].findById(groupFrom(res).id).orFail().lean()).toMatchObject({
      normalizedName: 'to read in 2027',
      bookIds: [],
      deletedAt: null,
    });
  });

  it('omits an unset description and allows a preset or any other name', async () => {
    const { groups } = await signInWithGroups(kind);

    const group = await addGroup(groups, 'Philosophy');

    expect(group).not.toHaveProperty('description');
  });

  it.each(['personal development', ' Personal  Development ', 'PERSONAL\tDEVELOPMENT'])(
    'rejects %j as a duplicate of Personal Development with 409 CONFLICT',
    async (duplicate) => {
      const { groups } = await signInWithGroups(kind);
      await addGroup(groups, 'Personal Development');

      const res = await groups.create({ name: duplicate });

      expect(res.status).toBe(409);
      expect(res.body).toEqual({
        error: {
          code: 'CONFLICT',
          message: `A ${label} with this name already exists`,
          requestId: res.headers['x-request-id'],
        },
      });
      expect(res.text).not.toContain('11000');
      expect(res.text).not.toContain('dup key');
    },
  );

  it('treats composed and decomposed accents as the same name', async () => {
    const { groups } = await signInWithGroups(kind);
    await addGroup(groups, 'Café reads');

    expect((await groups.create({ name: 'Café  READS' })).status).toBe(409);
  });

  it('lets two readers use the same name, and one reader use it for both kinds', async () => {
    const app = createAuthTestApp();
    const jane = await signInLibraryReader(app);
    const omar = await signInLibraryReader(app);

    const janes = await addGroup(jane[kind], 'Favourites');
    const omars = await addGroup(omar[kind], 'Favourites');
    const otherKind = kind === 'categories' ? jane.collections : jane.categories;
    const sameNameOtherKind = await addGroup(otherKind, 'Favourites');

    expect(new Set([janes.id, omars.id, sameNameOtherKind.id]).size).toBe(3);
    expect(groupsFrom(await jane[kind].list()).map((group) => group.id)).toEqual([janes.id]);
  });

  it('lists groups alphabetically by normalized name with pagination', async () => {
    const { groups } = await signInWithGroups(kind);
    for (const name of ['zebra', 'Émile', 'apple', 'Banana', 'éclair'])
      await addGroup(groups, name);

    const firstPage = await groups.list({ limit: '3' });
    const secondPage = await groups.list({ limit: '3', page: '2' });

    expect(groupsFrom(firstPage).map((group) => group.name)).toEqual(['apple', 'Banana', 'zebra']);
    expect(groupsFrom(secondPage).map((group) => group.name)).toEqual(['éclair', 'Émile']);
    expect(paginationOf(firstPage)).toEqual({ page: 1, limit: 3, total: 5, totalPages: 2 });
  });

  it('returns one group and rejects a malformed id', async () => {
    const { groups } = await signInWithGroups(kind);
    const group = await addGroup(groups, 'Science', 'Popular science');

    const res = await groups.get(group.id);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: group });
    expect(invalidFieldsOf(await groups.get('nope'))).toEqual([`${label}Id`]);
  });

  it('renames, keeps a case-only rename, and clears the description', async () => {
    const { groups } = await signInWithGroups(kind);
    const group = await addGroup(groups, 'science', 'Popular science');

    const caseOnly = await groups.update(group.id, { name: 'Science' });
    const cleared = await groups.update(group.id, { description: null });
    const renamed = await groups.update(group.id, { name: ' Hard   Science ', description: 'x' });

    expect(groupFrom(caseOnly)).toMatchObject({ name: 'Science', description: 'Popular science' });
    expect(groupFrom(cleared)).toEqual({
      id: group.id,
      name: 'Science',
      createdAt: group.createdAt,
      updatedAt: expect.stringMatching(ISO_TIMESTAMP),
    });
    expect(groupFrom(renamed)).toMatchObject({ name: 'Hard Science', description: 'x' });
    expect(await MODELS[kind].findById(group.id).orFail().lean()).toMatchObject({
      normalizedName: 'hard science',
    });
  });

  it('refuses renaming to another active group’s name but allows a deleted one’s', async () => {
    const { groups } = await signInWithGroups(kind);
    const science = await addGroup(groups, 'Science');
    const history = await addGroup(groups, 'History');
    const retired = await addGroup(groups, 'Retired');
    await groups.remove(retired.id);

    const clash = await groups.update(history.id, { name: 'SCIENCE' });
    const reuse = await groups.update(history.id, { name: 'Retired' });

    expect(clash.status).toBe(409);
    expect(clash.body.error.code).toBe('CONFLICT');
    expect(reuse.status).toBe(200);
    expect(groupFrom(await groups.get(science.id)).name).toBe('Science');
  });

  it.each([
    ['an empty body', {}, ['body']],
    ['a null name', { name: null }, ['name']],
    ['a blank name', { name: '   ' }, ['name']],
    ['a too long name', { name: 'n'.repeat(101) }, ['name']],
    ['a blank description', { description: '' }, ['description']],
    ['a too long description', { description: 'd'.repeat(501) }, ['description']],
    ['ownership fields', { name: 'x', ownerId: UNUSED_ID }, ['ownerId']],
    ['internal fields', { name: 'x', bookIds: [], deletedAt: null }, ['bookIds', 'deletedAt']],
  ])('rejects %s on PATCH with 400', async (_label, changes, fields) => {
    const { groups } = await signInWithGroups(kind);
    const group = await addGroup(groups, 'Science');

    expect(invalidFieldsOf(await groups.update(group.id, changes))).toEqual(fields);
    expect(groupFrom(await groups.get(group.id))).toEqual(group);
  });

  it.each([
    ['a missing name', {}, ['name']],
    ['a blank name', { name: ' ' }, ['name']],
    ['unknown fields', { name: 'x', normalizedName: 'x', id: UNUSED_ID }, ['normalizedName', 'id']],
  ])('rejects %s on create with 400 and stores nothing', async (_label, body, fields) => {
    const { groups } = await signInWithGroups(kind);

    expect(invalidFieldsOf(await groups.create(body))).toEqual(fields);
    expect(await MODELS[kind].countDocuments()).toBe(0);
  });

  it.each([
    ['an unknown parameter', { sort: 'name' }, ['sort']],
    ['a repeated parameter', 'page=1&page=2', ['page']],
    ['page zero', { page: '0' }, ['page']],
    ['a limit over 100', { limit: '101' }, ['limit']],
  ])('rejects %s on the list with 400', async (_label, query, fields) => {
    const { groups } = await signInWithGroups(kind);

    expect(invalidFieldsOf(await groups.list(query))).toEqual(fields);
  });

  it('soft-deletes a group: 204 with no body, kept in storage, hidden everywhere afterwards', async () => {
    const { reader, groups } = await signInWithGroups(kind);
    const group = await addGroup(groups, 'Science');
    const book = await addPhysicalBook(reader);
    await putBookInGroup(groups, group.id, book.id);

    const res = await groups.remove(group.id);

    expect(res.status).toBe(204);
    expect(res.text).toBe('');
    expect(await MODELS[kind].findById(group.id).orFail().lean()).toMatchObject({
      name: 'Science',
      deletedAt: expect.any(Date),
    });
    expectNotFound(await groups.get(group.id), notFoundMessage);
    expectNotFound(await groups.update(group.id, { name: 'Back' }), notFoundMessage);
    expectNotFound(await groups.remove(group.id), notFoundMessage);
    expectNotFound(await groups.addBook(group.id, book.id), notFoundMessage);
    expectNotFound(await groups.removeBook(group.id, book.id), notFoundMessage);
    expectNotFound(await groups.listBooks(group.id), notFoundMessage);
    expect((await groups.list()).body.data).toEqual([]);
    expect(reader.organizationOf && (await reader.organizationOf(book.id)).body.data[kind]).toEqual(
      [],
    );
  });

  it('lets a deleted group’s name be reused by a new, empty group', async () => {
    const { reader, groups } = await signInWithGroups(kind);
    const book = await addPhysicalBook(reader);
    const old = await addGroup(groups, 'Science');
    await putBookInGroup(groups, old.id, book.id);
    await groups.remove(old.id);

    const replacement = await addGroup(groups, 'science');

    expect(replacement.id).not.toBe(old.id);
    expect((await groups.listBooks(replacement.id)).body.data).toEqual([]);
    expect(await MODELS[kind].findById(old.id).orFail().lean()).toMatchObject({
      deletedAt: expect.any(Date),
    });
    expect(groupsFrom(await groups.list()).map((group) => group.id)).toEqual([replacement.id]);
  });

  it('responds identically for missing and foreign groups and never changes them', async () => {
    const app = createAuthTestApp();
    const reader = await signInLibraryReader(app);
    const otherReader = await signInLibraryReader(app);
    const foreign = await addGroup(otherReader[kind], 'Theirs');
    const book = await addPhysicalBook(reader);

    for (const groupId of [UNUSED_ID, foreign.id]) {
      expectNotFound(await reader[kind].get(groupId), notFoundMessage);
      expectNotFound(await reader[kind].update(groupId, { name: 'Hijacked' }), notFoundMessage);
      expectNotFound(await reader[kind].remove(groupId), notFoundMessage);
      expectNotFound(await reader[kind].addBook(groupId, book.id), notFoundMessage);
      expectNotFound(await reader[kind].removeBook(groupId, book.id), notFoundMessage);
      expectNotFound(await reader[kind].listBooks(groupId), notFoundMessage);
    }
    expect(await MODELS[kind].findById(foreign.id).orFail().lean()).toMatchObject({
      name: 'Theirs',
      bookIds: [],
      deletedAt: null,
    });
  });
});
