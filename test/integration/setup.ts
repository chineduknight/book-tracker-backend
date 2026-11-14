import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach } from 'vitest';
import { RefreshTokenModel } from '../../src/modules/auth/refresh-token.model.js';
import { SessionModel } from '../../src/modules/auth/session.model.js';
import { BookModel } from '../../src/modules/books/book.model.js';
import { CategoryModel } from '../../src/modules/categories/category.model.js';
import { BookCollectionModel } from '../../src/modules/collections/collection.model.js';
import { PhysicalCopyModel } from '../../src/modules/copies/copy.model.js';
import { LocationModel } from '../../src/modules/locations/location.model.js';
import { NoteModel } from '../../src/modules/notes/note.model.js';
import { ReadingSessionModel } from '../../src/modules/reading/reading.model.js';
import { UserModel } from '../../src/modules/users/user.model.js';
import { WishlistItemModel } from '../../src/modules/wishlist/wishlist.model.js';

const TEST_DATABASE_NAME = 'book-tracker-test';

function testDatabaseUri(): string {
  const uri = process.env.MONGODB_TEST_URI;
  if (!uri) {
    throw new Error(
      'MONGODB_TEST_URI is required for integration tests, ' +
        'e.g. MONGODB_TEST_URI=mongodb://127.0.0.1:27017/book-tracker-test',
    );
  }
  return uri;
}

async function deleteAuthData(): Promise<void> {
  await Promise.all([
    UserModel.deleteMany({}),
    SessionModel.deleteMany({}),
    RefreshTokenModel.deleteMany({}),
    BookModel.deleteMany({}),
    LocationModel.deleteMany({}),
    PhysicalCopyModel.deleteMany({}),
    ReadingSessionModel.deleteMany({}),
    NoteModel.deleteMany({}),
    CategoryModel.deleteMany({}),
    BookCollectionModel.deleteMany({}),
    WishlistItemModel.deleteMany({}),
  ]);
}

beforeAll(async () => {
  await mongoose.connect(testDatabaseUri(), {
    dbName: TEST_DATABASE_NAME,
    serverSelectionTimeoutMS: 5_000,
  });
  await Promise.all([
    UserModel.syncIndexes(),
    SessionModel.syncIndexes(),
    RefreshTokenModel.syncIndexes(),
    BookModel.syncIndexes(),
    LocationModel.syncIndexes(),
    PhysicalCopyModel.syncIndexes(),
    ReadingSessionModel.syncIndexes(),
    NoteModel.syncIndexes(),
    CategoryModel.syncIndexes(),
    BookCollectionModel.syncIndexes(),
    WishlistItemModel.syncIndexes(),
  ]);
});

beforeEach(async () => {
  await deleteAuthData();
});

afterAll(async () => {
  await deleteAuthData();
  await mongoose.disconnect();
});
