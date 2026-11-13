import { describe, expect, it, vi } from 'vitest';
import { createLogger, fatalErrorHandler } from '../src/config/logger.js';
import { createCredentialError, createLogCapture, expectNoCredentials } from './helpers.js';

function parseLines(output: string): Record<string, unknown>[] {
  return output
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('logger error serialization', () => {
  it('reduces errors logged under `err` to name and code', () => {
    const logs = createLogCapture();
    createLogger('info', logs.stream).error({ err: createCredentialError() }, 'failed');

    expectNoCredentials(logs.output());
    expect(parseLines(logs.output())[0]).toMatchObject({
      level: 50,
      msg: 'failed',
      err: { name: 'Error', code: 'ECONNREFUSED' },
    });
  });

  it('sanitizes errors passed as the first argument', () => {
    const logs = createLogCapture();
    createLogger('info', logs.stream).error(createCredentialError(), 'failed');

    expectNoCredentials(logs.output());
    expect(parseLines(logs.output())[0]).toMatchObject({ err: { name: 'Error' } });
  });
});

describe('fatalErrorHandler', () => {
  it.each([
    ['an Error', createCredentialError()],
    ['a thrown string', `mongodb+srv://admin:hunter2@cluster0.db.example.test`],
  ])('logs %s safely at fatal level and exits with code 1', (_label, thrown) => {
    const logs = createLogCapture();
    const exit = vi.fn();

    fatalErrorHandler(createLogger('info', logs.stream), 'Uncaught exception', exit)(thrown);

    expect(exit).toHaveBeenCalledWith(1);
    expectNoCredentials(logs.output());
    expect(parseLines(logs.output())[0]).toMatchObject({ level: 60, msg: 'Uncaught exception' });
  });
});
