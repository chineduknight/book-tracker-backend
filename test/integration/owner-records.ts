import mongoose from 'mongoose';
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

const OWNED_MODELS = [
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

/**
 * Every stored document of one user, straight from the driver and serialized as canonical
 * Extended JSON, so two snapshots are equal only if no byte of the user's data changed.
 */
export async function serializedRecordsOf(userId: string): Promise<string> {
  const id = new mongoose.Types.ObjectId(userId);
  const byId = { _id: 1 } as const;
  const sessions = await SessionModel.collection.find({ userId: id }).sort(byId).toArray();
  const records = {
    user: await UserModel.collection.find({ _id: id }).toArray(),
    sessions,
    refreshTokens: await RefreshTokenModel.collection
      .find({ sessionId: { $in: sessions.map((session) => session._id) } })
      .sort(byId)
      .toArray(),
    ...Object.fromEntries(
      await Promise.all(
        OWNED_MODELS.map(async (model) => [
          model.collection.collectionName,
          await model.collection.find({ ownerId: id }).sort(byId).toArray(),
        ]),
      ),
    ),
  };
  return mongoose.mongo.BSON.EJSON.stringify(records, { relaxed: false });
}
