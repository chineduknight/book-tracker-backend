import { describe, expect, it } from 'vitest';
import { UnsafeDatabaseTargetError } from '../scripts/local-database-target.js';
import { testDatabaseUri } from './integration/test-database.js';

/** Validation only: none of these tests opens a connection. */
function refusalOf(uri: string | undefined): UnsafeDatabaseTargetError {
  try {
    testDatabaseUri(uri === undefined ? {} : { MONGODB_TEST_URI: uri });
  } catch (error) {
    if (error instanceof UnsafeDatabaseTargetError) return error;
    throw error;
  }
  throw new Error('expected the URI to be refused');
}

describe('integration test database target', () => {
  it.each([
    [
      'mongodb://127.0.0.1:27017/book-tracker-test',
      'mongodb://127.0.0.1:27017/book-tracker-test?directConnection=true',
    ],
    [
      'mongodb://localhost/book-tracker-test?serverSelectionTimeoutMS=2000',
      'mongodb://localhost/book-tracker-test?serverSelectionTimeoutMS=2000&directConnection=true',
    ],
    [
      'mongodb://[::1]:27018/book-tracker-test?directConnection=true',
      'mongodb://[::1]:27018/book-tracker-test?directConnection=true',
    ],
    [
      'mongodb://LOCALHOST:27017/book-tracker-test',
      'mongodb://LOCALHOST:27017/book-tracker-test?directConnection=true',
    ],
    [
      'mongodb://tester:local-only@127.0.0.1/book-tracker-test?authSource=admin',
      'mongodb://tester:local-only@127.0.0.1/book-tracker-test?authSource=admin&directConnection=true',
    ],
  ])('accepts the local test database %s', (uri, expected) => {
    expect(testDatabaseUri({ MONGODB_TEST_URI: uri })).toBe(expected);
  });

  it.each([
    ['an SRV cluster', 'mongodb+srv://admin:hunter2@cluster0.db.example.test/book-tracker-test'],
    ['a remote host', 'mongodb://admin:hunter2@db.example.test:27017/book-tracker-test'],
    ['a remote IP address', 'mongodb://admin:hunter2@10.0.0.5/book-tracker-test'],
    ['a public IP address', 'mongodb://admin:hunter2@203.0.113.7:27017/book-tracker-test'],
    ['a look-alike host', 'mongodb://admin:hunter2@localhost.example.test/book-tracker-test'],
    ['a host hiding behind user info', 'mongodb://127.0.0.1@db.example.test/book-tracker-test'],
    ['an abbreviated loopback address', 'mongodb://admin:hunter2@127.1/book-tracker-test'],
    ['every interface', 'mongodb://admin:hunter2@0.0.0.0/book-tracker-test'],
    ['several hosts', 'mongodb://admin:hunter2@127.0.0.1,db.example.test/book-tracker-test'],
    [
      'several hosts with ports',
      'mongodb://admin:hunter2@127.0.0.1:27017,db.example.test:27017/book-tracker-test',
    ],
    ['the production database', 'mongodb://admin:hunter2@127.0.0.1/book-tracker'],
    ['the development database', 'mongodb://admin:hunter2@127.0.0.1/book-tracker-dev'],
    ['the smoke database', 'mongodb://admin:hunter2@127.0.0.1/book-tracker-smoke'],
    ['a look-alike database', 'mongodb://admin:hunter2@127.0.0.1/book-tracker-test-prod'],
    ['an encoded database name', 'mongodb://admin:hunter2@127.0.0.1/book-tracker-tes%74'],
    ['no database', 'mongodb://admin:hunter2@127.0.0.1'],
    ['the default database', 'mongodb://admin:hunter2@127.0.0.1/'],
    ['replica-set discovery', 'mongodb://admin:hunter2@127.0.0.1/book-tracker-test?replicaSet=rs0'],
    [
      'replica-set discovery in lower case',
      'mongodb://admin:hunter2@127.0.0.1/book-tracker-test?replicaset=rs0',
    ],
    ['a load balancer', 'mongodb://admin:hunter2@127.0.0.1/book-tracker-test?loadBalanced=true'],
    ['a proxy', 'mongodb://admin:hunter2@127.0.0.1/book-tracker-test?proxyHost=db.example.test'],
    ['TLS to another name', 'mongodb://admin:hunter2@127.0.0.1/book-tracker-test?tls=true'],
    [
      'disabled direct connection',
      'mongodb://admin:hunter2@127.0.0.1/book-tracker-test?directConnection=false',
    ],
    [
      'a disguised option name',
      'mongodb://admin:hunter2@127.0.0.1/book-tracker-test?DirectConnection=false',
    ],
    ['surrounding whitespace', ' mongodb://admin:hunter2@127.0.0.1/book-tracker-test'],
    ['not a MongoDB URI', 'postgres://admin:hunter2@127.0.0.1/book-tracker-test'],
  ])('refuses %s without echoing the URI', (_label, uri) => {
    const { message } = refusalOf(uri);

    expect(message).toMatch(/^MONGODB_TEST_URI /);
    for (const secretPart of ['hunter2', 'admin', 'example.test', '10.0.0.5', '203.0.113.7']) {
      expect(message).not.toContain(secretPart);
    }
  });

  it('requires MONGODB_TEST_URI and suggests the local default', () => {
    expect(refusalOf(undefined).message).toContain(
      'MONGODB_TEST_URI=mongodb://127.0.0.1:27017/book-tracker-test',
    );
    expect(refusalOf('').message).toMatch(/^MONGODB_TEST_URI is required/);
  });

  it('names the reason for a refused database without naming the database', () => {
    expect(refusalOf('mongodb://127.0.0.1/attendance-prod').message).toBe(
      'MONGODB_TEST_URI must name the book-tracker-test database',
    );
  });
});
