import { describe, expect, it } from 'vitest';
import { BookModel } from '../../src/modules/books/book.model.js';
import { PhysicalCopyModel } from '../../src/modules/copies/copy.model.js';
import { createAuthTestApp } from './auth-fixtures.js';
import {
  addCopy,
  addPhysicalBook,
  copyFrom,
  expectNotFound,
  signInLibraryReader,
} from './library-fixtures.js';

const ROUNDS = 25;

async function physicalCopiesOnEbooks(): Promise<number> {
  const ebookIds = await BookModel.find({ format: 'ebook' }).distinct('_id');
  return PhysicalCopyModel.countDocuments({ bookId: { $in: ebookIds } });
}

describe('copy creation racing with book changes', () => {
  it('never leaves a physical copy on a book that became an ebook', async () => {
    const reader = await signInLibraryReader(createAuthTestApp());

    const outcomes = new Set<string>();
    for (let round = 0; round < ROUNDS; round += 1) {
      const book = await addPhysicalBook(reader, `Race ${round}`);
      const [created, formatChange] = await Promise.all([
        reader.copies.create(book.id, { label: 'Racing copy' }),
        reader.books.update(book.id, { format: 'ebook' }),
      ]);
      outcomes.add(
        `${created.status} ${created.body.error?.code ?? ''} / ${formatChange.status} ${formatChange.body.error?.code ?? ''}`.trim(),
      );
    }

    expect(await physicalCopiesOnEbooks()).toBe(0);
    for (const outcome of outcomes) {
      expect(['201  / 409 BOOK_HAS_PHYSICAL_COPIES', '409 BOOK_NOT_PHYSICAL / 200']).toContain(
        outcome,
      );
    }
  });

  it('never exposes a copy of a book deleted concurrently and keeps existing copies', async () => {
    const reader = await signInLibraryReader(createAuthTestApp());

    for (let round = 0; round < ROUNDS; round += 1) {
      const book = await addPhysicalBook(reader, `Delete race ${round}`);
      const existing = await addCopy(reader, book.id, { label: 'Existing' });

      const [created, deletion] = await Promise.all([
        reader.copies.create(book.id, { label: 'Racing copy' }),
        reader.books.remove(book.id),
      ]);

      expect(deletion.status).toBe(204);
      expect([201, 404]).toContain(created.status);
      expectNotFound(await reader.copies.listForBook(book.id), 'Book not found');
      expectNotFound(await reader.copies.get(existing.id), 'Copy not found');
      if (created.status === 201) {
        expectNotFound(await reader.copies.get(copyFrom(created).id), 'Copy not found');
      }
      expect(await PhysicalCopyModel.exists({ _id: existing.id, deletedAt: null })).not.toBeNull();
    }
  });
});
