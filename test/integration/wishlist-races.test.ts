import { describe, expect, it } from 'vitest';
import { WishlistItemModel } from '../../src/modules/wishlist/wishlist.model.js';
import { createAuthTestApp } from './auth-fixtures.js';
import {
  addEbook,
  addPhysicalBook,
  addWish,
  expectNotFound,
  signInLibraryReader,
  wishFrom,
} from './library-fixtures.js';

const ROUNDS = 5;
const CONCURRENT_ACQUISITIONS = 20;

function storedWish(id: string) {
  return WishlistItemModel.findById(id).orFail().lean();
}

describe('concurrent wishlist changes', () => {
  it('settles twenty simultaneous acquisitions split across two books on one stable link', async () => {
    const reader = await signInLibraryReader(createAuthTestApp());
    const books = [await addPhysicalBook(reader, 'Paper'), await addEbook(reader, 'Digital')];

    for (let round = 0; round < ROUNDS; round += 1) {
      const wish = await addWish(reader, { title: `Round ${round}` });

      const responses = await Promise.all(
        Array.from({ length: CONCURRENT_ACQUISITIONS }, (_, index) =>
          reader.wishlist.acquire(wish.id, { bookId: books[index % 2]!.id }),
        ),
      );

      const stored = await storedWish(wish.id);
      const winnerId = stored.acquiredBookId?.toHexString();
      expect(books.map((book) => book.id)).toContain(winnerId);
      expect(stored.status).toBe('acquired');
      expect(stored.acquiredAt).toBeInstanceOf(Date);
      expect(responses.map((res) => res.status).sort()).toEqual([
        ...Array<number>(10).fill(200),
        ...Array<number>(10).fill(409),
      ]);
      for (const res of responses) {
        if (res.status === 200) {
          expect(wishFrom(res)).toMatchObject({
            status: 'acquired',
            acquiredBookId: winnerId,
            acquiredAt: stored.acquiredAt?.toISOString(),
          });
        } else {
          expect(res.body.error.code).toBe('WISHLIST_ALREADY_ACQUIRED');
        }
      }
    }
  });

  it('never resurrects a wish when PATCH and DELETE race', async () => {
    const reader = await signInLibraryReader(createAuthTestApp());

    for (let round = 0; round < ROUNDS; round += 1) {
      const wish = await addWish(reader);

      const [update, removal] = await Promise.all([
        reader.wishlist.update(wish.id, { note: `Round ${round}` }),
        reader.wishlist.remove(wish.id),
      ]);

      expect(removal.status).toBe(204);
      expect([200, 404]).toContain(update.status);
      expect((await storedWish(wish.id)).deletedAt).toBeInstanceOf(Date);
      expectNotFound(await reader.wishlist.get(wish.id), 'Wishlist item not found');
    }
  });

  it('keeps a wish deleted when acquisition and DELETE race, with at most historical linkage', async () => {
    const reader = await signInLibraryReader(createAuthTestApp());
    const book = await addPhysicalBook(reader);

    for (let round = 0; round < ROUNDS; round += 1) {
      const wish = await addWish(reader);

      const [acquisition, removal] = await Promise.all([
        reader.wishlist.acquire(wish.id, { bookId: book.id }),
        reader.wishlist.remove(wish.id),
      ]);

      expect(removal.status).toBe(204);
      expect([200, 404]).toContain(acquisition.status);
      const stored = await storedWish(wish.id);
      expect(stored.deletedAt).toBeInstanceOf(Date);
      if (acquisition.status === 200) expect(stored.acquiredBookId?.toHexString()).toBe(book.id);
      else expect(stored.acquiredBookId).toBeNull();
      expectNotFound(await reader.wishlist.get(wish.id), 'Wishlist item not found');
      expect((await reader.wishlist.list({ status: 'all' })).body.data).toEqual([]);
    }
  });

  it('links only the reader’s own, then possibly hidden, book when book deletion races acquisition', async () => {
    const reader = await signInLibraryReader(createAuthTestApp());

    for (let round = 0; round < ROUNDS; round += 1) {
      const wish = await addWish(reader);
      const book = await addPhysicalBook(reader, `Race ${round}`);

      const [acquisition, removal] = await Promise.all([
        reader.wishlist.acquire(wish.id, { bookId: book.id }),
        reader.books.remove(book.id),
      ]);

      expect(removal.status).toBe(204);
      expect([200, 404]).toContain(acquisition.status);
      const stored = await storedWish(wish.id);
      if (acquisition.status === 200) {
        expect(stored).toMatchObject({ status: 'acquired' });
        expect(stored.acquiredBookId?.toHexString()).toBe(book.id);
      } else {
        expect(stored).toMatchObject({ status: 'wanted', acquiredBookId: null });
      }
      expect((await reader.books.get(book.id)).status).toBe(404);
    }
  });

  it('keeps every field when concurrent PATCHes change different fields', async () => {
    const reader = await signInLibraryReader(createAuthTestApp());
    const wish = await addWish(reader);

    const responses = await Promise.all([
      reader.wishlist.update(wish.id, { title: 'Renamed' }),
      reader.wishlist.update(wish.id, { priority: 'high' }),
      reader.wishlist.update(wish.id, { note: 'Noted' }),
      reader.wishlist.update(wish.id, { authors: ['Someone'] }),
    ]);

    expect(responses.map((res) => res.status)).toEqual([200, 200, 200, 200]);
    expect((await reader.wishlist.get(wish.id)).body.data).toMatchObject({
      title: 'Renamed',
      priority: 'high',
      note: 'Noted',
      authors: ['Someone'],
    });
    expect(await storedWish(wish.id)).toMatchObject({
      normalizedTitle: 'renamed',
      priorityRank: 0,
    });
  });
});
