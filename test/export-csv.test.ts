import { describe, expect, it } from 'vitest';
import { toCsvField, toCsvRecord } from '../src/modules/export/export.csv.js';
import {
  BOOKS_TABLE,
  LOANS_TABLE,
  READING_SESSIONS_TABLE,
} from '../src/modules/export/export.tables.js';
import { parseCsv } from './export-formats.js';

describe('toCsvField', () => {
  it.each([
    [null, ''],
    [undefined, ''],
    [0, '0'],
    [310, '310'],
    ['plain', 'plain'],
    ['with, comma', '"with, comma"'],
    ['say "hi"', '"say ""hi"""'],
    ['line\r\nbreak', '"line\r\nbreak"'],
    ['line\nbreak', '"line\nbreak"'],
    ['Ünïcödé 📚', 'Ünïcödé 📚'],
  ])('encodes %j as %j', (value, field) => {
    expect(toCsvField(value)).toBe(field);
  });

  it.each(['=1+1', '+1', '-1', '@SUM(A1)', ' =1', '\u0007=1', '\t=1', '\tplain', '\r=1', '\n -x'])(
    'neutralizes the formula-like %j with a leading apostrophe',
    (value) => {
      expect(parseCsv(toCsvRecord([value]))[0]?.[0]).toBe(`'${value}`);
    },
  );

  it.each(['a=b', 'Plain - title', ' plain', '2026-11-14', '["-a"]'])(
    'leaves %j as it is',
    (value) => {
      expect(parseCsv(toCsvRecord([value]))[0]?.[0]).toBe(value);
    },
  );
});

describe('toCsvRecord', () => {
  it('ends every record with CRLF and survives a round trip through a strict parser', () => {
    const values = ['a,b', 'c"d', 'e\r\nf', '', 'g'];

    const record = toCsvRecord(values);

    expect(record.endsWith('\r\n')).toBe(true);
    expect(parseCsv(record + toCsvRecord(['x']))).toEqual([values, ['x']]);
  });
});

describe('export tables', () => {
  it.each([
    [BOOKS_TABLE, 14],
    [READING_SESSIONS_TABLE, 11],
    [LOANS_TABLE, 11],
  ] as const)('has one value per column', (table, columns) => {
    expect(table.columns).toHaveLength(columns);
  });
});
