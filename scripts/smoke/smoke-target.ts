import { SmokeRunError } from './smoke-errors.js';

export const SMOKE_DATABASE_NAME = 'book-tracker-smoke';

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const HARMLESS_OPTIONS = new Set([
  'appName',
  'authMechanism',
  'authSource',
  'connectTimeoutMS',
  'directConnection',
  'serverSelectionTimeoutMS',
]);
const SINGLE_HOST_URI = /^mongodb:\/\/(?:([^@/?]*)@)?([^/?@]+)\/([^?]*)(?:\?(.*))?$/;
const HOST_AND_PORT = /^(\[[^\]]+\]|[^:]+)(?::(\d{1,5}))?$/;

function hostOf(hostAndPort: string): string | undefined {
  return HOST_AND_PORT.exec(hostAndPort)?.[1]?.toLowerCase();
}

/**
 * Validates that a destructive smoke reset can only reach a local MongoDB's smoke database, before
 * any connection is opened, and returns the URI to use with `directConnection=true` so the driver
 * never follows replica-set discovery to another server.
 */
export function toLocalSmokeDatabaseUri(uri: string): string {
  const parts = SINGLE_HOST_URI.exec(uri);
  if (!parts) {
    throw new SmokeRunError(
      `MONGODB_SMOKE_URI must be a mongodb:// URI with one local host and the ${SMOKE_DATABASE_NAME} database`,
    );
  }
  const [, credentials, hostAndPort = '', databaseName, query = ''] = parts;

  const host = hostOf(hostAndPort);
  if (host === undefined || !LOCAL_HOSTS.has(host)) {
    throw new SmokeRunError(
      'MONGODB_SMOKE_URI must point at a local MongoDB (127.0.0.1, localhost or [::1])',
    );
  }
  if (databaseName !== SMOKE_DATABASE_NAME) {
    throw new SmokeRunError(`MONGODB_SMOKE_URI must name the ${SMOKE_DATABASE_NAME} database`);
  }

  const options = new URLSearchParams(query);
  const unexpectedOption = [...options.keys()].find((option) => !HARMLESS_OPTIONS.has(option));
  if (unexpectedOption !== undefined) {
    throw new SmokeRunError(
      `MONGODB_SMOKE_URI may only use the options ${[...HARMLESS_OPTIONS].join(', ')}`,
    );
  }
  if (options.has('directConnection') && options.get('directConnection') !== 'true') {
    throw new SmokeRunError('MONGODB_SMOKE_URI must not disable directConnection');
  }
  options.set('directConnection', 'true');

  const userInfo = credentials === undefined ? '' : `${credentials}@`;
  return `mongodb://${userInfo}${hostAndPort}/${SMOKE_DATABASE_NAME}?${options.toString()}`;
}

export function toSmokePort(text: string): number {
  const port = Number(text);
  if (!/^\d{1,5}$/.test(text) || port < 1 || port > 65_535) {
    throw new SmokeRunError('SMOKE_PORT must be a whole number from 1 to 65535');
  }
  return port;
}
