import { describe, expect, it } from 'vitest';
import { closingWhenDone, type ClosableCursor } from '../src/shared/archive-cursor.js';

/** Like a Mongoose cursor: iterable, closable, and without an iterator `return()`. */
function fakeCursor(rows: number[], failAfter?: number) {
  const cursor = {
    closed: false,
    close() {
      cursor.closed = true;
      return Promise.resolve();
    },
    [Symbol.asyncIterator]() {
      let position = 0;
      return {
        next(): Promise<IteratorResult<number>> {
          if (position === failAfter) return Promise.reject(new Error('connection lost'));
          const value = rows[position];
          position += 1;
          return Promise.resolve(
            value === undefined ? { done: true, value: undefined } : { done: false, value },
          );
        },
      };
    },
  };
  return cursor satisfies ClosableCursor<number>;
}

describe('closingWhenDone', () => {
  it('yields every row and closes the cursor at the end', async () => {
    const cursor = fakeCursor([1, 2, 3]);
    const rows: number[] = [];

    for await (const row of closingWhenDone(cursor)) rows.push(row);

    expect(rows).toEqual([1, 2, 3]);
    expect(cursor.closed).toBe(true);
  });

  it('closes the cursor when the reader stops early', async () => {
    const cursor = fakeCursor([1, 2, 3]);

    await expect(async () => {
      for await (const row of closingWhenDone(cursor)) {
        if (row === 2) throw new Error('limit reached');
      }
    }).rejects.toThrow('limit reached');

    expect(cursor.closed).toBe(true);
  });

  it('closes the cursor when reading from it fails', async () => {
    const cursor = fakeCursor([1, 2, 3], 1);

    await expect(async () => {
      for await (const row of closingWhenDone(cursor)) expect(row).toBe(1);
    }).rejects.toThrow('connection lost');

    expect(cursor.closed).toBe(true);
  });
});
