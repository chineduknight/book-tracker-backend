import { describe, expect, it } from 'vitest';
import { BookModel } from '../../src/modules/books/book.model.js';
import { PhysicalCopyModel } from '../../src/modules/copies/copy.model.js';
import { WishlistItemModel } from '../../src/modules/wishlist/wishlist.model.js';
import { createAuthTestApp } from './auth-fixtures.js';
import {
  addEbook,
  addPhysicalBook,
  addWish,
  expectNotFound,
  invalidFieldsOf,
  signInLibraryReader,
  UNUSED_ID,
  wishFrom,
} from './library-fixtures.js';

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function storedWish(id: string) {
  return WishlistItemModel.findById(id).orFail().lean();
}

describe('PUT /api/v1/wishlist/:wishlistItemId/acquisition', () => {
  it.each([
    ['a physical book', addPhysicalBook],
    ['an ebook', addEbook],
  ])('marks a wish acquired with %s without touching the catalogue', async (_label, addBook) => {
    const reader = await signInLibraryReader(createAuthTestApp());
    const wish = await addWish(reader, { title: 'Dune', preferredFormat: 'ebook' });
    const book = await addBook(reader, 'Dune');
    const booksBefore = await BookModel.find().lean();

    const res = await reader.wishlist.acquire(wish.id, { bookId: book.id });

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(wishFrom(res)).toEqual({
      ...wish,
      status: 'acquired',
      acquiredBookId: book.id,
      acquiredAt: expect.stringMatching(ISO_TIMESTAMP),
      updatedAt: expect.stringMatching(ISO_TIMESTAMP),
    });
    expect(await BookModel.find().lean()).toEqual(booksBefore);
    expect(await PhysicalCopyModel.countDocuments()).toBe(0);
    expect((await reader.books.list()).body.meta.pagination.total).toBe(1);
  });

  it('is idempotent for the same book, even in upper-case hex, writing nothing', async () => {
    const reader = await signInLibraryReader(createAuthTestApp());
    const wish = await addWish(reader);
    const book = await addPhysicalBook(reader);
    const first = wishFrom(await reader.wishlist.acquire(wish.id, { bookId: book.id }));

    const repeat = await reader.wishlist.acquire(wish.id, { bookId: book.id });
    const upperCase = await reader.wishlist.acquire(wish.id, { bookId: book.id.toUpperCase() });

    expect(repeat.status).toBe(200);
    expect(wishFrom(repeat)).toEqual(first);
    expect(wishFrom(upperCase)).toEqual(first);
    expect((await storedWish(wish.id)).updatedAt.toISOString()).toBe(first.updatedAt);
  });

  it('refuses a different book once acquired and leaves the link unchanged', async () => {
    const reader = await signInLibraryReader(createAuthTestApp());
    const wish = await addWish(reader);
    const book = await addPhysicalBook(reader);
    const otherBook = await addEbook(reader);
    const first = wishFrom(await reader.wishlist.acquire(wish.id, { bookId: book.id }));

    const res = await reader.wishlist.acquire(wish.id, { bookId: otherBook.id });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: {
        code: 'WISHLIST_ALREADY_ACQUIRED',
        message: 'This wishlist item was already acquired with a different book',
        requestId: res.headers['x-request-id'],
      },
    });
    expect((await reader.wishlist.get(wish.id)).body.data).toEqual(first);
  });

  it('lets several wishes be fulfilled by the same book', async () => {
    const reader = await signInLibraryReader(createAuthTestApp());
    const book = await addPhysicalBook(reader);
    const wishes = await Promise.all([addWish(reader), addWish(reader, { title: 'Dune (again)' })]);

    for (const wish of wishes) {
      expect(
        wishFrom(await reader.wishlist.acquire(wish.id, { bookId: book.id })).acquiredBookId,
      ).toBe(book.id);
    }
  });

  it('rejects a body without exactly bookId', async () => {
    const reader = await signInLibraryReader(createAuthTestApp());
    const wish = await addWish(reader);
    const book = await addPhysicalBook(reader);

    expect(invalidFieldsOf(await reader.wishlist.acquire(wish.id, {}))).toEqual(['bookId']);
    expect(invalidFieldsOf(await reader.wishlist.acquire(wish.id, { bookId: 'abc' }))).toEqual([
      'bookId',
    ]);
    expect(
      invalidFieldsOf(await reader.wishlist.acquire(wish.id, { bookId: book.id, acquiredAt: 'x' })),
    ).toEqual(['acquiredAt']);
    expect(invalidFieldsOf(await reader.wishlist.acquire('abc', { bookId: book.id }))).toEqual([
      'wishlistItemId',
    ]);
    expect((await storedWish(wish.id)).status).toBe('wanted');
  });

  it('responds 404 "Book not found" for a missing, foreign or deleted book, even with the same title', async () => {
    const app = createAuthTestApp();
    const reader = await signInLibraryReader(app);
    const otherReader = await signInLibraryReader(app);
    const wish = await addWish(reader, { title: 'Dune' });
    const foreignBook = await addPhysicalBook(otherReader, 'Dune');
    const deletedBook = await addPhysicalBook(reader, 'Dune');
    await reader.books.remove(deletedBook.id);

    for (const bookId of [UNUSED_ID, foreignBook.id, deletedBook.id]) {
      expectNotFound(await reader.wishlist.acquire(wish.id, { bookId }), 'Book not found');
    }
    expect(await storedWish(wish.id)).toMatchObject({ status: 'wanted', acquiredBookId: null });
  });

  it('checks the book before the item, and reports missing, foreign and deleted items alike', async () => {
    const app = createAuthTestApp();
    const reader = await signInLibraryReader(app);
    const otherReader = await signInLibraryReader(app);
    const book = await addPhysicalBook(reader);
    const foreignWish = await addWish(otherReader);
    const deletedWish = await addWish(reader);
    await reader.wishlist.remove(deletedWish.id);

    expectNotFound(
      await reader.wishlist.acquire(UNUSED_ID, { bookId: UNUSED_ID }),
      'Book not found',
    );
    for (const id of [UNUSED_ID, foreignWish.id, deletedWish.id]) {
      expectNotFound(
        await reader.wishlist.acquire(id, { bookId: book.id }),
        'Wishlist item not found',
      );
    }
    expect(await storedWish(foreignWish.id)).toMatchObject({ status: 'wanted' });
    expect(await storedWish(deletedWish.id)).toMatchObject({ status: 'wanted' });
  });

  it('keeps the acquisition as history after the book is deleted', async () => {
    const reader = await signInLibraryReader(createAuthTestApp());
    const wish = await addWish(reader);
    const book = await addPhysicalBook(reader);
    const acquired = wishFrom(await reader.wishlist.acquire(wish.id, { bookId: book.id }));

    expect((await reader.books.remove(book.id)).status).toBe(204);

    expect((await reader.wishlist.get(wish.id)).body.data).toEqual(acquired);
    expect((await reader.wishlist.list({ status: 'acquired' })).body.data).toEqual([acquired]);
    expect((await reader.books.get(book.id)).status).toBe(404);
    expect((await reader.wishlist.acquire(wish.id, { bookId: book.id })).status).toBe(404);
  });

  it('still lets metadata be corrected on an acquired item without changing the acquisition', async () => {
    const reader = await signInLibraryReader(createAuthTestApp());
    const wish = await addWish(reader);
    const book = await addPhysicalBook(reader);
    const acquired = wishFrom(await reader.wishlist.acquire(wish.id, { bookId: book.id }));

    const res = await reader.wishlist.update(wish.id, {
      note: 'Bought second hand',
      priority: 'low',
    });

    expect(wishFrom(res)).toEqual({
      ...acquired,
      note: 'Bought second hand',
      priority: 'low',
      updatedAt: expect.stringMatching(ISO_TIMESTAMP),
    });
    expect(invalidFieldsOf(await reader.wishlist.update(wish.id, { status: 'wanted' }))).toEqual([
      'status',
    ]);
    expect(
      invalidFieldsOf(
        await reader.wishlist.update(wish.id, { acquiredBookId: null, acquiredAt: null }),
      ),
    ).toEqual(['acquiredBookId', 'acquiredAt']);
    expect(await storedWish(wish.id)).toMatchObject({
      status: 'acquired',
      acquiredAt: new Date(acquired.acquiredAt ?? ''),
    });
  });
});
