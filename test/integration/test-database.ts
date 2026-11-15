import mongoose from 'mongoose';
import {
  toLocalDisposableDatabaseUri,
  UnsafeDatabaseTargetError,
} from '../../scripts/local-database-target.js';

export const TEST_DATABASE_NAME = 'book-tracker-test';
const TEST_DATABASE_VARIABLE = 'MONGODB_TEST_URI';

/*
 * The integration suite deletes every document before each test, so the URI is validated before
 * any connection, index build or delete: one local host, exactly this database, harmless options.
 */
export function testDatabaseUri(environment: NodeJS.ProcessEnv = process.env): string {
  const uri = environment[TEST_DATABASE_VARIABLE];
  if (!uri) {
    throw new UnsafeDatabaseTargetError(
      `${TEST_DATABASE_VARIABLE} is required for integration tests, ` +
        `e.g. ${TEST_DATABASE_VARIABLE}=mongodb://127.0.0.1:27017/${TEST_DATABASE_NAME}`,
    );
  }
  return toLocalDisposableDatabaseUri(uri, {
    variable: TEST_DATABASE_VARIABLE,
    databaseName: TEST_DATABASE_NAME,
  });
}

export async function connectToTestDatabase(): Promise<void> {
  await mongoose.connect(testDatabaseUri(), {
    dbName: TEST_DATABASE_NAME,
    serverSelectionTimeoutMS: 5_000,
  });
}
