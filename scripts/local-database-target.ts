/** A refusal whose message names only the variable and the rule it broke, never the URI. */
export class UnsafeDatabaseTargetError extends Error {
  override readonly name = 'UnsafeDatabaseTargetError';
}

export interface DisposableDatabase {
  /** The environment variable the URI came from, used in error messages. */
  variable: string;
  /** The only database the URI may name. */
  databaseName: string;
}

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
 * Validates, before any connection is opened, that a URI used by a destructive tool (one that
 * deletes or drops data) can only reach the named database on a local MongoDB, and returns it with
 * `directConnection=true` so the driver never follows replica-set discovery to another server.
 * Anything unexpected is refused: there is no remote opt-in.
 */
export function toLocalDisposableDatabaseUri(
  uri: string,
  { variable, databaseName }: DisposableDatabase,
): string {
  const parts = SINGLE_HOST_URI.exec(uri);
  if (!parts) {
    throw new UnsafeDatabaseTargetError(
      `${variable} must be a mongodb:// URI with one local host and the ${databaseName} database`,
    );
  }
  const [, credentials, hostAndPort = '', requestedDatabase, query = ''] = parts;

  const host = hostOf(hostAndPort);
  if (host === undefined || !LOCAL_HOSTS.has(host)) {
    throw new UnsafeDatabaseTargetError(
      `${variable} must point at a local MongoDB (127.0.0.1, localhost or [::1])`,
    );
  }
  if (requestedDatabase !== databaseName) {
    throw new UnsafeDatabaseTargetError(`${variable} must name the ${databaseName} database`);
  }

  const options = new URLSearchParams(query);
  const unexpectedOption = [...options.keys()].find((option) => !HARMLESS_OPTIONS.has(option));
  if (unexpectedOption !== undefined) {
    throw new UnsafeDatabaseTargetError(
      `${variable} may only use the options ${[...HARMLESS_OPTIONS].join(', ')}`,
    );
  }
  if (options.has('directConnection') && options.get('directConnection') !== 'true') {
    throw new UnsafeDatabaseTargetError(`${variable} must not disable directConnection`);
  }
  options.set('directConnection', 'true');

  const userInfo = credentials === undefined ? '' : `${credentials}@`;
  return `mongodb://${userInfo}${hostAndPort}/${databaseName}?${options.toString()}`;
}
