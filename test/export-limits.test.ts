import { describe, expect, it } from 'vitest';
import { BoundedExportWriter } from '../src/modules/export/export.limits.js';

describe('BoundedExportWriter', () => {
  it('accepts exactly the record limit and refuses one more', () => {
    const writer = new BoundedExportWriter({ maxRecords: 2, maxBytes: 100 });

    writer.countRecord();
    writer.countRecord();

    expect(writer.records).toBe(2);
    expect(() => writer.countRecord()).toThrow(
      expect.objectContaining({ statusCode: 413, code: 'EXPORT_TOO_LARGE' }),
    );
  });

  it('counts UTF-8 bytes, not characters, including prepended text', () => {
    const writer = new BoundedExportWriter({ maxRecords: 10, maxBytes: 9 });

    writer.write('é');
    writer.write('📚');
    writer.prepend('abc');

    expect(writer.toString()).toBe('abcé📚');
    expect(() => writer.write('x')).toThrow(expect.objectContaining({ code: 'EXPORT_TOO_LARGE' }));
  });

  it('keeps nothing of a write that crossed the limit', () => {
    const writer = new BoundedExportWriter({ maxRecords: 10, maxBytes: 3 });
    writer.write('ab');

    expect(() => writer.write('cd')).toThrow();
    expect(writer.toString()).toBe('ab');
  });
});
