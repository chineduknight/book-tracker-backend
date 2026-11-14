import mongoose from 'mongoose';
import { beforeEach, describe, expect, it } from 'vitest';
import { CategoryModel } from '../../src/modules/categories/category.model.js';
import { BookCollectionModel } from '../../src/modules/collections/collection.model.js';
import { indexesUsedBy, stagesUsedBy } from './query-plans.js';

const ownerId = new mongoose.Types.ObjectId();
const bookId = new mongoose.Types.ObjectId();
const activeGroups = { ownerId, deletedAt: null };
const ALPHABETICAL = { normalizedName: 1, _id: 1 } as const;

async function seedGroupsOfSeveralReaders(
  model: typeof CategoryModel | typeof BookCollectionModel,
) {
  const owners = [ownerId, new mongoose.Types.ObjectId(), new mongoose.Types.ObjectId()];
  await model.insertMany(
    owners.flatMap((owner) =>
      Array.from({ length: 30 }, (_, index) => ({
        ownerId: owner,
        name: `Group ${index}`,
        normalizedName: `group ${index}`,
        bookIds: index % 3 === 0 ? [bookId, new mongoose.Types.ObjectId()] : [],
        deletedAt: index % 5 === 0 ? new Date() : null,
      })),
    ),
  );
}

describe.each([
  ['category', CategoryModel],
  ['collection', BookCollectionModel],
] as const)('%s indexes', (_label, model) => {
  beforeEach(() => seedGroupsOfSeveralReaders(model));

  it('declares the planned indexes with a partial unique name per owner among active groups', async () => {
    const indexes = await model.collection.indexes();

    expect(indexes.map((index) => index.name).sort()).toEqual([
      '_id_',
      'owner_active_alphabetical',
      'owner_active_books',
      'owner_active_unique_name',
    ]);
    expect(indexes.find((index) => index.name === 'owner_active_unique_name')).toMatchObject({
      key: { ownerId: 1, normalizedName: 1 },
      unique: true,
      partialFilterExpression: { deletedAt: null },
    });
    expect(indexes.filter((index) => index.unique).map((index) => index.name)).toEqual([
      'owner_active_unique_name',
    ]);
  });

  it('lets the database refuse a second active group with the same normalized name', async () => {
    await expect(
      model.create({ ownerId, name: 'Group 1', normalizedName: 'group 1', bookIds: [] }),
    ).rejects.toMatchObject({ code: 11000 });
    await expect(
      model.create({ ownerId, name: 'Group 0', normalizedName: 'group 0', bookIds: [] }),
    ).resolves.toMatchObject({ normalizedName: 'group 0' });
  });

  it('serves the alphabetical list from an owner-scoped index without sorting in memory', async () => {
    const list = () => model.find(activeGroups).sort(ALPHABETICAL);

    expect(await indexesUsedBy(list())).toEqual(['owner_active_alphabetical']);
    expect(await stagesUsedBy(list())).not.toContain('SORT');
  });

  it('finds the groups containing a book through the owner-scoped multikey index', async () => {
    const containing = () => model.find({ ...activeGroups, bookIds: bookId }).sort(ALPHABETICAL);

    expect(await indexesUsedBy(containing())).toContain('owner_active_books');
    expect(await containing().countDocuments()).toBe(8);
  });

  it('resolves one group by id and owner without scanning the collection', async () => {
    const group = await model.findOne(activeGroups).orFail().lean();
    const lookup = () => model.find({ ...activeGroups, _id: group._id });

    expect(await stagesUsedBy(lookup())).not.toContain('COLLSCAN');
  });
});
