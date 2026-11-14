import mongoose from 'mongoose';
import { beforeEach, describe, expect, it } from 'vitest';
import { LoanModel } from '../../src/modules/loans/loan.model.js';
import { indexesUsedBy, stagesUsedBy } from './query-plans.js';

const ownerId = new mongoose.Types.ObjectId();
const copyId = new mongoose.Types.ObjectId();
const RECENT = { createdAt: -1, _id: -1 } as const;

async function seedLoansOfSeveralReaders() {
  const owners = [ownerId, new mongoose.Types.ObjectId(), new mongoose.Types.ObjectId()];
  await LoanModel.insertMany(
    owners.flatMap((owner) =>
      Array.from({ length: 30 }, (_, index) => ({
        ownerId: owner,
        copyId: index % 6 === 0 ? copyId : new mongoose.Types.ObjectId(),
        bookId: new mongoose.Types.ObjectId(),
        borrowerName: `Borrower ${index}`,
        lentOn: '2026-01-01',
        dueOn: index % 3 === 0 ? '2026-02-01' : undefined,
        returnedOn: index % 6 === 0 ? `2026-03-${String((index % 28) + 1).padStart(2, '0')}` : null,
      })),
    ),
  );
}

describe('loan indexes', () => {
  beforeEach(seedLoansOfSeveralReaders);

  it('declares the planned indexes with one partial unique active-loan index', async () => {
    const indexes = await LoanModel.collection.indexes();

    expect(indexes.map((index) => index.name).sort()).toEqual([
      '_id_',
      'owner_copy_recent',
      'owner_copy_single_active',
      'owner_recent',
      'owner_returned_recent',
    ]);
    expect(indexes.find((index) => index.name === 'owner_copy_single_active')).toMatchObject({
      key: { ownerId: 1, copyId: 1 },
      unique: true,
      partialFilterExpression: { returnedOn: null },
    });
    expect(indexes.filter((index) => index.unique).map((index) => index.name)).toEqual([
      'owner_copy_single_active',
    ]);
  });

  it('lets the database refuse a second active loan per copy, whether returnedOn is null or missing', async () => {
    const owner = new mongoose.Types.ObjectId();
    const copy = new mongoose.Types.ObjectId();
    const base = {
      ownerId: owner,
      copyId: copy,
      bookId: new mongoose.Types.ObjectId(),
      borrowerName: 'A',
      lentOn: '2026-01-01',
    };

    await LoanModel.collection.insertOne({ ...base });
    await expect(LoanModel.collection.insertOne({ ...base })).rejects.toMatchObject({
      code: 11000,
    });
    await expect(
      LoanModel.collection.insertOne({ ...base, returnedOn: null }),
    ).rejects.toMatchObject({
      code: 11000,
    });
    await expect(LoanModel.create(base)).rejects.toMatchObject({ code: 11000 });
    await LoanModel.collection.insertOne({ ...base, returnedOn: '2026-02-01' });
    await LoanModel.collection.insertOne({ ...base, returnedOn: '2026-02-02' });
    expect(await LoanModel.countDocuments({ ownerId: owner, copyId: copy })).toBe(3);
  });

  it.each([
    [
      'one copy’s history',
      () => LoanModel.find({ ownerId, copyId }).sort(RECENT),
      ['owner_copy_recent'],
    ],
    [
      'all loans',
      () => LoanModel.find({ ownerId }).sort({ createdAt: 1, _id: 1 }),
      ['owner_recent'],
    ],
    [
      'active loans',
      () => LoanModel.find({ ownerId, returnedOn: null }).sort(RECENT),
      ['owner_returned_recent', 'owner_recent'],
    ],
    [
      'the active loan of one copy',
      () => LoanModel.find({ ownerId, copyId, returnedOn: null }),
      ['owner_copy_single_active'],
    ],
  ])('serves %s from an owner-scoped index', async (_label, query, expected) => {
    const indexes = await indexesUsedBy(query());
    expect(indexes).toHaveLength(1);
    expect(expected).toContain(indexes[0]);
    expect(await stagesUsedBy(query())).not.toContain('COLLSCAN');
  });

  it('serves returned and overdue history from an owner-scoped index without a collection scan', async () => {
    for (const query of [
      () => LoanModel.find({ ownerId, returnedOn: { $ne: null } }).sort(RECENT),
      () =>
        LoanModel.find({ ownerId, returnedOn: null, dueOn: { $lt: '2026-02-15' } }).sort(RECENT),
    ]) {
      const indexes = await indexesUsedBy(query());
      expect(indexes).toHaveLength(1);
      expect(indexes[0]).toMatch(/^owner_/);
      expect(await stagesUsedBy(query())).not.toContain('COLLSCAN');
    }
  });
});
