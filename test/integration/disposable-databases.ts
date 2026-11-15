import mongoose, { type Connection } from 'mongoose';
import { applicationModelsOn } from '../../src/db/application-models.js';
import { connectionOptionsFor } from '../../src/db/mongo.js';
import { testDatabaseUri, type TEST_DATABASE_NAME } from './test-database.js';

export type DisposableDatabaseName = `${typeof TEST_DATABASE_NAME}-${string}`;

/**
 * A URI for a throwaway database on the same guarded local server as the test database. Only
 * names prefixed with the test database name are possible, so a drill can never reach a real one.
 */
export function disposableDatabaseUri(databaseName: DisposableDatabaseName): string {
  const uri = new URL(testDatabaseUri());
  uri.pathname = `/${databaseName}`;
  return uri.toString();
}

/** Opens its own connection like an operator tool would: no automatic collections or indexes. */
export async function openDisposableDatabase(
  databaseName: DisposableDatabaseName,
  { buildIndexesOnConnect = false } = {},
): Promise<Connection> {
  const connection = mongoose.createConnection(
    disposableDatabaseUri(databaseName),
    connectionOptionsFor({ buildIndexesOnConnect }),
  );
  await connection.asPromise();
  await connection.dropDatabase();
  return connection;
}

export async function dropDisposableDatabase(connection: Connection): Promise<void> {
  await connection.dropDatabase();
  await connection.close();
}

export function databaseOf(connection: Connection) {
  if (!connection.db) throw new Error('The connection is not open');
  return connection.db;
}

export async function indexNamesOf(connection: Connection): Promise<Record<string, string[]>> {
  const database = databaseOf(connection);
  const collections = await database.listCollections({}, { nameOnly: true }).toArray();
  const names: Record<string, string[]> = {};
  for (const { name } of collections) {
    const indexes = await database.collection(name).indexes();
    names[name] = indexes.map((index) => String(index.name)).sort();
  }
  return names;
}

/** Builds every index the schemas define, as a freshly prepared database would have. */
export async function buildEveryRequiredIndex(connection: Connection): Promise<void> {
  for (const { modelName } of applicationModelsOn(connection)) {
    await connection.model(modelName).createIndexes();
  }
}
