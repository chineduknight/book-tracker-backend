import { randomBytes } from 'node:crypto';
import { Writable } from 'node:stream';
import mongoose from 'mongoose';
import { expect, vi } from 'vitest';
import { createApp, type AppOptions } from '../src/app.js';
import { createLogger } from '../src/config/logger.js';

export const ALLOWED_ORIGIN = 'http://localhost:5173';

/** A fake credential-bearing connection string used to prove secrets never leak. */
export const CREDENTIAL_URI = 'mongodb+srv://admin:hunter2@cluster0.db.example.test/book-tracker';

/** An error whose message, stack, cause and own properties all carry the credential URI. */
export function createCredentialError(): Error {
  const error = new Error(`failed to connect to ${CREDENTIAL_URI}`, {
    cause: new Error(`auth failed for ${CREDENTIAL_URI}`),
  });
  Object.assign(error, { code: 'ECONNREFUSED', connectionString: CREDENTIAL_URI });
  return error;
}

/** Asserts that no part of the credential URI (user, password, host or scheme) is present. */
export function expectNoCredentials(text: string): void {
  for (const fragment of ['hunter2', 'admin:', 'cluster0', 'mongodb+srv', 'mongodb://']) {
    expect(text).not.toContain(fragment);
  }
}

/** Collects log lines written by a logger so tests can inspect them. */
export function createLogCapture() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      lines.push(chunk.toString());
      callback();
    },
  });
  return { stream, output: () => lines.join('') };
}

/** A disposable signing secret generated per test run; never a committed value. */
export const TEST_ACCESS_TOKEN_SECRET = randomBytes(32);

export function createTestApp(overrides: Partial<AppOptions> = {}) {
  return createApp({
    logger: createLogger('silent'),
    corsOrigins: [ALLOWED_ORIGIN],
    accessTokenSecret: TEST_ACCESS_TOKEN_SECRET,
    ...overrides,
  });
}

/** Simulate the default Mongoose connection being in a given state without a real database. */
export function mockDatabaseState(state: mongoose.ConnectionStates): void {
  vi.spyOn(mongoose.connection, 'readyState', 'get').mockReturnValue(state);
}
