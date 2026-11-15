import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach } from 'vitest';
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
import { connectToTestDatabase } from './test-database.js';

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
    LoanModel.deleteMany({}),
  ]);
}

beforeAll(async () => {
  await connectToTestDatabase();
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
    LoanModel.syncIndexes(),
  ]);
});

beforeEach(async () => {
  await deleteAuthData();
});

afterAll(async () => {
  await deleteAuthData();
  await mongoose.disconnect();
});
