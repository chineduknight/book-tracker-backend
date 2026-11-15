import { toLocalDisposableDatabaseUri } from '../local-database-target.js';
import { SmokeRunError } from './smoke-errors.js';

export const SMOKE_DATABASE_NAME = 'book-tracker-smoke';

/** The smoke reset drops its database, so it may only reach the local smoke database. */
export function toLocalSmokeDatabaseUri(uri: string): string {
  return toLocalDisposableDatabaseUri(uri, {
    variable: 'MONGODB_SMOKE_URI',
    databaseName: SMOKE_DATABASE_NAME,
  });
}

export function toSmokePort(text: string): number {
  const port = Number(text);
  if (!/^\d{1,5}$/.test(text) || port < 1 || port > 65_535) {
    throw new SmokeRunError('SMOKE_PORT must be a whole number from 1 to 65535');
  }
  return port;
}
