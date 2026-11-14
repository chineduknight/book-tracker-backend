import { describe, expect, it } from 'vitest';
import type { ExportLimits } from '../../src/modules/export/export.limits.js';
import { EXPORT_LIMITS } from '../../src/modules/export/export.limits.js';
import { createAuthTestApp } from './auth-fixtures.js';
import { addRichLibrary } from './export-fixtures.js';
import { addNote, addPhysicalBook, signInLibraryReader } from './library-fixtures.js';

const RICH_LIBRARY_RECORDS = 16;

async function signInWithLimits(limits: ExportLimits) {
  const reader = await signInLibraryReader(createAuthTestApp({ exportLimits: limits }));
  return reader;
}

function expectTooLarge(res: { status: number; headers: Record<string, string>; body: unknown }) {
  expect(res.status).toBe(413);
  expect(res.headers['cache-control']).toBe('no-store');
  expect(res.headers['content-type']).toBe('application/json; charset=utf-8');
  expect(res.headers['content-disposition']).toBeUndefined();
  expect(res.body).toEqual({
    error: {
      code: 'EXPORT_TOO_LARGE',
      message: 'This export is larger than a single download allows; please contact support',
      requestId: res.headers['x-request-id'],
    },
  });
}

describe('export size limits', () => {
  it('allows exactly the record limit and refuses one record more, without any partial download', async () => {
    const atLimit = await signInWithLimits({ ...EXPORT_LIMITS, maxRecords: RICH_LIBRARY_RECORDS });
    await addRichLibrary(atLimit);
    const overLimit = await signInWithLimits({
      ...EXPORT_LIMITS,
      maxRecords: RICH_LIBRARY_RECORDS - 1,
    });
    await addRichLibrary(overLimit);

    expect((await atLimit.exports.archive()).status).toBe(200);
    expectTooLarge(await overLimit.exports.archive());
  });

  it('allows exactly the byte limit, counting UTF-8 bytes, and refuses one byte less', async () => {
    const measuring = await signInWithLimits(EXPORT_LIMITS);
    const book = await addPhysicalBook(measuring, '📚 Ünïcödé');
    await addNote(measuring, book.id, { kind: 'note', content: '🎉'.repeat(500) });
    const body = (await measuring.exports.notesMarkdown()).text;
    const bytes = Buffer.byteLength(body, 'utf8');
    expect(bytes).toBeGreaterThan(body.length);

    for (const [maxBytes, status] of [
      [bytes, 200],
      [bytes - 1, 413],
    ] as const) {
      const reader = await signInWithLimits({ ...EXPORT_LIMITS, maxBytes });
      const readersBook = await addPhysicalBook(reader, '📚 Ünïcödé');
      await addNote(reader, readersBook.id, { kind: 'note', content: '🎉'.repeat(500) });
      const res = await reader.exports.notesMarkdown();
      expect(res.status).toBe(status);
      if (status === 200) expect(Buffer.byteLength(res.text, 'utf8')).toBe(maxBytes);
      else expectTooLarge(res);
    }
  });

  it('applies the limits to each spreadsheet and Markdown download on its own', async () => {
    const reader = await signInWithLimits({ ...EXPORT_LIMITS, maxRecords: 2 });
    for (const title of ['A', 'B', 'C']) await addPhysicalBook(reader, title);

    expectTooLarge(await reader.exports.booksCsv());
    expectTooLarge(await reader.exports.notesMarkdown());
    expect((await reader.exports.loansCsv()).status).toBe(200);
    expect((await reader.exports.readingSessionsCsv()).status).toBe(200);
  });

  it('documents the V1 limits', () => {
    expect(EXPORT_LIMITS).toEqual({ maxRecords: 20_000, maxBytes: 32 * 1024 * 1024 });
  });
});
