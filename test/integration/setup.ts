import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach } from 'vitest';
import { SessionModel } from '../../src/modules/auth/session.model.js';
import { UserModel } from '../../src/modules/users/user.model.js';

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

beforeAll(async () => {
  await mongoose.connect(testDatabaseUri(), {
    dbName: TEST_DATABASE_NAME,
    serverSelectionTimeoutMS: 5_000,
  });
  await Promise.all([UserModel.syncIndexes(), SessionModel.syncIndexes()]);
});

beforeEach(async () => {
  await Promise.all([UserModel.deleteMany({}), SessionModel.deleteMany({})]);
});

afterAll(async () => {
  await Promise.all([UserModel.deleteMany({}), SessionModel.deleteMany({})]);
  await mongoose.disconnect();
});
