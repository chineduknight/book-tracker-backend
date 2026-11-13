import { describe, expect, it } from 'vitest';
import { formatSafeError, toSafeError } from '../src/shared/safe-error.js';
import { CREDENTIAL_URI, createCredentialError, expectNoCredentials } from './helpers.js';

describe('toSafeError', () => {
  it('keeps only the error name and code', () => {
    const safe = toSafeError(createCredentialError());

    expect(safe).toEqual({ name: 'Error', code: 'ECONNREFUSED' });
    expectNoCredentials(JSON.stringify(safe));
  });

  it('keeps custom error class names and numeric driver codes', () => {
    class MongoServerError extends Error {
      override name = 'MongoServerError';
      code = 18;
    }

    expect(toSafeError(new MongoServerError(CREDENTIAL_URI))).toEqual({
      name: 'MongoServerError',
      code: 18,
    });
  });

  it('drops names and codes that are not plain identifiers', () => {
    const error = new Error('boom');
    error.name = CREDENTIAL_URI;
    Object.assign(error, { code: `E_${CREDENTIAL_URI}` });

    expect(toSafeError(error)).toEqual({ name: 'Error' });
  });

  it.each([CREDENTIAL_URI, { uri: CREDENTIAL_URI }, null, undefined, 42])(
    'reduces non-Error thrown values to a placeholder (%j)',
    (value) => {
      expect(toSafeError(value)).toEqual({ name: 'NonErrorThrown' });
    },
  );

  it("unwraps pino's pre-serialized error objects", () => {
    const original = createCredentialError();
    const serialized = {
      type: 'Error',
      message: original.message,
      stack: original.stack,
      raw: original,
    };

    expect(toSafeError(serialized)).toEqual({ name: 'Error', code: 'ECONNREFUSED' });
  });
});

describe('formatSafeError', () => {
  it('formats name and code without the message', () => {
    const text = formatSafeError(createCredentialError());

    expect(text).toBe('Error (ECONNREFUSED)');
    expectNoCredentials(text);
  });

  it('formats errors without a code', () => {
    expect(formatSafeError(new TypeError(CREDENTIAL_URI))).toBe('TypeError');
  });
});
