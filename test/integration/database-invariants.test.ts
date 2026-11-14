import mongoose from 'mongoose';
import { describe, expect, it } from 'vitest';
import { RefreshTokenModel } from '../../src/modules/auth/refresh-token.model.js';
import { SessionModel } from '../../src/modules/auth/session.model.js';
import { BookModel } from '../../src/modules/books/book.model.js';
import { CategoryModel } from '../../src/modules/categories/category.model.js';
import { BookCollectionModel } from '../../src/modules/collections/collection.model.js';
import { PhysicalCopyModel } from '../../src/modules/copies/copy.model.js';
import { LoanModel } from '../../src/modules/loans/loan.model.js';
import { LocationModel } from '../../src/modules/locations/location.model.js';
import { NoteModel } from '../../src/modules/notes/note.model.js';
import { ReadingSessionModel } from '../../src/modules/reading/reading.model.js';
import { UserModel } from '../../src/modules/users/user.model.js';
import { WishlistItemModel } from '../../src/modules/wishlist/wishlist.model.js';

const OWNER_SCOPED_MODELS = [
  BookModel,
  LocationModel,
  PhysicalCopyModel,
  ReadingSessionModel,
  NoteModel,
  CategoryModel,
  BookCollectionModel,
  WishlistItemModel,
  LoanModel,
];
const ACCOUNT_MODELS = [UserModel, SessionModel, RefreshTokenModel];

interface IndexDescription {
  name?: string;
  key: Record<string, unknown>;
  unique?: boolean;
  partialFilterExpression?: unknown;
  expireAfterSeconds?: number;
}

async function indexesOf(model: { collection: mongoose.Collection }) {
  return (await model.collection.indexes()) as IndexDescription[];
}

/** The indexes MongoDB actually holds that constrain data: unique, partial or expiring. */
async function constrainingIndexes() {
  const rows: string[] = [];
  for (const model of [...ACCOUNT_MODELS, ...OWNER_SCOPED_MODELS]) {
    for (const index of await indexesOf(model)) {
      const rules = [
        index.unique && 'unique',
        index.partialFilterExpression !== undefined &&
          `partial ${JSON.stringify(index.partialFilterExpression)}`,
        index.expireAfterSeconds !== undefined && `expires after ${index.expireAfterSeconds}s`,
      ].filter(Boolean);
      if (rules.length > 0) {
        rows.push(
          `${model.collection.collectionName} ${JSON.stringify(index.key)}: ${rules.join(', ')}`,
        );
      }
    }
  }
  return rows.sort();
}

describe('database invariants as built by syncIndexes', () => {
  it('leads every index of an owner-scoped collection with ownerId', async () => {
    for (const model of OWNER_SCOPED_MODELS) {
      for (const index of await indexesOf(model)) {
        if (index.name === '_id_') continue;
        expect(Object.keys(index.key)[0], `${model.collection.collectionName}.${index.name}`).toBe(
          'ownerId',
        );
      }
    }
  });

  it('holds exactly the planned unique, partial and expiring indexes', async () => {
    expect(await constrainingIndexes()).toEqual([
      'bookcollections {"ownerId":1,"normalizedName":1}: unique, partial {"deletedAt":null}',
      'books {"ownerId":1,"deletedAt":1,"normalizedIsbn":1}: partial {"normalizedIsbn":{"$exists":true}}',
      'categories {"ownerId":1,"normalizedName":1}: unique, partial {"deletedAt":null}',
      'loans {"ownerId":1,"copyId":1}: unique, partial {"returnedOn":null}',
      'locations {"ownerId":1,"normalizedName":1}: unique',
      'readingsessions {"ownerId":1,"bookId":1}: unique, partial {"status":"in_progress"}',
      'refreshtokens {"expiresAt":1}: expires after 0s',
      'refreshtokens {"sessionId":1}: unique, partial {"status":"active"}',
      'refreshtokens {"tokenHash":1}: unique',
      'sessions {"expiresAt":1}: expires after 0s',
      'users {"email":1}: unique',
    ]);
  });

  it('refuses a second account with the same normalized email even through the driver', async () => {
    const account = { name: 'One', email: 'same@example.test', passwordHash: 'x' };
    await UserModel.collection.insertOne({ ...account });

    await expect(UserModel.collection.insertOne({ ...account, name: 'Two' })).rejects.toMatchObject(
      { code: 11000 },
    );
  });

  it('refuses a second active refresh token for one session even through the driver', async () => {
    const sessionId = new mongoose.Types.ObjectId();
    const expiresAt = new Date(Date.now() + 60_000);
    await RefreshTokenModel.collection.insertOne({
      sessionId,
      tokenHash: 'first',
      status: 'active',
      expiresAt,
    });
    await RefreshTokenModel.collection.insertOne({
      sessionId,
      tokenHash: 'consumed',
      status: 'consumed',
      expiresAt,
    });

    await expect(
      RefreshTokenModel.collection.insertOne({
        sessionId,
        tokenHash: 'second',
        status: 'active',
        expiresAt,
      }),
    ).rejects.toMatchObject({ code: 11000 });
  });
});
