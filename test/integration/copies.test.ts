import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { PhysicalCopyModel } from '../../src/modules/copies/copy.model.js';
import { bearer, createAuthTestApp } from './auth-fixtures.js';
import {
  addCopy,
  addEbook,
  addLocation,
  addPhysicalBook,
  COPY_DTO_KEYS,
  copiesFrom,
  copyFrom,
  expectNotFound,
  paginationOf,
  signInLibraryReader,
  UNUSED_ID,
} from './library-fixtures.js';

const OBJECT_ID_HEX = /^[0-9a-f]{24}$/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

describe('POST /api/v1/books/:bookId/copies', () => {
  it('creates independently described copies of one physical book', async () => {
    const reader = await signInLibraryReader(createAuthTestApp());
    const book = await addPhysicalBook(reader);
    const home = await addLocation(reader, 'Home');

    const signed = await reader.copies.create(book.id, {
      label: 'Signed copy',
      condition: 'like_new',
      storageNote: '  Top shelf ',
      locationId: home.id,
    });
    const reading = await addCopy(reader, book.id, {
      label: 'Reading copy',
      condition: 'fair',
      locationId: home.id,
    });
    const unassigned = await addCopy(reader, book.id);

    expect(signed.status).toBe(201);
    expect(signed.headers['cache-control']).toBe('no-store');
    expect(signed.headers.location).toBe(`/api/v1/copies/${copyFrom(signed).id}`);
    expect(signed.body).toEqual({
      data: {
        id: expect.stringMatching(OBJECT_ID_HEX),
        bookId: book.id,
        locationId: home.id,
        label: 'Signed copy',
        condition: 'like_new',
        storageNote: 'Top shelf',
        createdAt: expect.stringMatching(ISO_UTC),
        updatedAt: expect.stringMatching(ISO_UTC),
      },
    });
    expect(Object.keys(copyFrom(signed)).sort()).toEqual([...COPY_DTO_KEYS].sort());
    expect(reading).toMatchObject({
      label: 'Reading copy',
      condition: 'fair',
      locationId: home.id,
    });
    expect(unassigned).toEqual({
      id: expect.stringMatching(OBJECT_ID_HEX),
      bookId: book.id,
      locationId: null,
      createdAt: expect.stringMatching(ISO_UTC),
      updatedAt: expect.stringMatching(ISO_UTC),
    });
    expect(new Set([copyFrom(signed).id, reading.id, unassigned.id]).size).toBe(3);
    for (const internal of ['ownerId', 'deletedAt', '_id', '__v', 'isOnLoan', 'isAvailable']) {
      expect(signed.text).not.toContain(internal);
    }
  });

  it('accepts an explicit null location and a request without a body', async () => {
    const app = createAuthTestApp();
    const reader = await signInLibraryReader(app);
    const book = await addPhysicalBook(reader);

    expect((await addCopy(reader, book.id, { locationId: null })).locationId).toBeNull();
    const withoutBody = await request(app)
      .post(`/api/v1/books/${book.id}/copies`)
      .set('Authorization', bearer(reader.tokens.accessToken));
    expect(withoutBody.status).toBe(201);
    expect(copyFrom(withoutBody).locationId).toBeNull();
  });

  it('refuses copies for an ebook with 409 BOOK_NOT_PHYSICAL', async () => {
    const reader = await signInLibraryReader(createAuthTestApp());
    const ebook = await addEbook(reader);

    const res = await reader.copies.create(ebook.id, { label: 'Copy 1' });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: {
        code: 'BOOK_NOT_PHYSICAL',
        message: 'Physical copies can only be added to physical books',
        requestId: res.headers['x-request-id'],
      },
    });
    expect(await PhysicalCopyModel.countDocuments()).toBe(0);
  });

  it('returns the same 404 for a missing, deleted or foreign book, even a foreign ebook', async () => {
    const app = createAuthTestApp();
    const jane = await signInLibraryReader(app);
    const omar = await signInLibraryReader(app);
    const deleted = await addPhysicalBook(jane, 'Deleted');
    await jane.books.remove(deleted.id);
    const omarsBook = await addPhysicalBook(omar);
    const omarsEbook = await addEbook(omar);

    for (const bookId of [UNUSED_ID, deleted.id, omarsBook.id, omarsEbook.id]) {
      expectNotFound(await jane.copies.create(bookId), 'Book not found');
    }
    expect(await PhysicalCopyModel.countDocuments()).toBe(0);
  });

  it('rejects a foreign or missing location identically and a malformed one as invalid', async () => {
    const app = createAuthTestApp();
    const jane = await signInLibraryReader(app);
    const omar = await signInLibraryReader(app);
    const book = await addPhysicalBook(jane);
    const omarsHome = await addLocation(omar, 'Home');

    expectNotFound(
      await jane.copies.create(book.id, { locationId: omarsHome.id }),
      'Location not found',
    );
    expectNotFound(
      await jane.copies.create(book.id, { locationId: UNUSED_ID }),
      'Location not found',
    );
    const malformed = await jane.copies.create(book.id, { locationId: { $ne: null } });
    expect(malformed.status).toBe(400);
    expect(malformed.body.error.details).toEqual([
      { field: 'locationId', message: expect.any(String) },
    ]);
    expect(await PhysicalCopyModel.countDocuments()).toBe(0);
  });

  it.each(['ownerId', 'bookId', 'isOnLoan', 'deletedAt'])(
    'rejects the injected field %s',
    async (field) => {
      const reader = await signInLibraryReader(createAuthTestApp());
      const book = await addPhysicalBook(reader);

      const res = await reader.copies.create(book.id, { [field]: UNUSED_ID });

      expect(res.status).toBe(400);
      expect(res.body.error.details).toEqual([{ field, message: 'Unknown field' }]);
    },
  );
});

describe('GET /api/v1/books/:bookId/copies', () => {
  it('pages newest first with location and condition filters', async () => {
    const reader = await signInLibraryReader(createAuthTestApp());
    const book = await addPhysicalBook(reader);
    const home = await addLocation(reader, 'Home');
    const office = await addLocation(reader, 'Office');
    const created = [];
    for (const [locationId, condition] of [
      [home.id, 'good'],
      [office.id, 'good'],
      [home.id, 'poor'],
      [null, 'good'],
      [home.id, 'good'],
    ] as const) {
      created.push(await addCopy(reader, book.id, { locationId, condition }));
    }
    const newestFirst = created.map((copy) => copy.id).reverse();

    const firstPage = await reader.copies.listForBook(book.id, { limit: '2' });
    const lastPage = await reader.copies.listForBook(book.id, { page: '3', limit: '2' });
    const atHome = await reader.copies.listForBook(book.id, { locationId: home.id });
    const goodAtHome = await reader.copies.listForBook(book.id, {
      locationId: home.id,
      condition: 'good',
    });

    expect(copiesFrom(firstPage).map((copy) => copy.id)).toEqual(newestFirst.slice(0, 2));
    expect(copiesFrom(lastPage).map((copy) => copy.id)).toEqual(newestFirst.slice(4));
    expect(paginationOf(lastPage)).toEqual({ page: 3, limit: 2, total: 5, totalPages: 3 });
    expect(paginationOf(atHome).total).toBe(3);
    expect(copiesFrom(goodAtHome).map((copy) => copy.id)).toEqual([created[4]?.id, created[0]?.id]);
    expect(paginationOf(goodAtHome).total).toBe(2);
  });

  it('returns an empty page for a visible ebook and for a physical book without copies', async () => {
    const reader = await signInLibraryReader(createAuthTestApp());
    const ebook = await addEbook(reader);
    const book = await addPhysicalBook(reader);

    for (const bookId of [ebook.id, book.id]) {
      expect((await reader.copies.listForBook(bookId)).body).toEqual({
        data: [],
        meta: { pagination: { page: 1, limit: 20, total: 0, totalPages: 0 } },
      });
    }
  });

  it('never shows another reader’s copies or accepts their location as a filter', async () => {
    const app = createAuthTestApp();
    const jane = await signInLibraryReader(app);
    const omar = await signInLibraryReader(app);
    const janesBook = await addPhysicalBook(jane);
    await addCopy(jane, janesBook.id);
    const omarsHome = await addLocation(omar, 'Home');
    const omarsBook = await addPhysicalBook(omar);

    expectNotFound(await omar.copies.listForBook(janesBook.id), 'Book not found');
    expectNotFound(
      await jane.copies.listForBook(janesBook.id, { locationId: omarsHome.id }),
      'Location not found',
    );
    expect(copiesFrom(await omar.copies.listForBook(omarsBook.id))).toEqual([]);
  });

  it.each([['locationId=home'], ['condition=mint'], ['sort=oldest'], ['limit=101']])(
    'rejects ?%s',
    async (query) => {
      const reader = await signInLibraryReader(createAuthTestApp());
      const book = await addPhysicalBook(reader);

      const res = await reader.copies.listForBook(book.id, query);

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    },
  );
});

describe('GET, PATCH and DELETE /api/v1/copies/:copyId', () => {
  it('returns the reader’s copy and rejects malformed ids', async () => {
    const reader = await signInLibraryReader(createAuthTestApp());
    const book = await addPhysicalBook(reader);
    const copy = await addCopy(reader, book.id, { label: 'Copy 1' });

    expect((await reader.copies.get(copy.id)).body).toEqual({ data: copy });
    const malformed = await reader.copies.get('copy-1');
    expect(malformed.status).toBe(400);
    expect(malformed.body.error.details).toEqual([
      { field: 'copyId', message: 'must be a 24-character hexadecimal id' },
    ]);
  });

  it('changes only supplied fields and clears explicit nulls', async () => {
    const reader = await signInLibraryReader(createAuthTestApp());
    const book = await addPhysicalBook(reader);
    const home = await addLocation(reader, 'Home');
    const office = await addLocation(reader, 'Office');
    const copy = await addCopy(reader, book.id, {
      label: 'Copy 1',
      condition: 'good',
      storageNote: 'Shelf 2',
      locationId: home.id,
    });

    const moved = await reader.copies.update(copy.id, { locationId: office.id, condition: 'fair' });
    const cleared = await reader.copies.update(copy.id, {
      locationId: null,
      label: null,
      condition: null,
      storageNote: null,
    });

    expect(copyFrom(moved)).toMatchObject({
      locationId: office.id,
      condition: 'fair',
      label: 'Copy 1',
      storageNote: 'Shelf 2',
    });
    expect(copyFrom(cleared)).toEqual({
      id: copy.id,
      bookId: book.id,
      locationId: null,
      createdAt: copy.createdAt,
      updatedAt: expect.stringMatching(ISO_UTC),
    });
  });

  it('cannot move a copy to another book, owner or foreign location', async () => {
    const app = createAuthTestApp();
    const jane = await signInLibraryReader(app);
    const omar = await signInLibraryReader(app);
    const book = await addPhysicalBook(jane);
    const otherBook = await addPhysicalBook(jane, 'Dune');
    const copy = await addCopy(jane, book.id);
    const omarsHome = await addLocation(omar, 'Home');

    for (const changes of [{ bookId: otherBook.id }, { ownerId: omar.userId }]) {
      expect((await jane.copies.update(copy.id, changes)).status).toBe(400);
    }
    expectNotFound(
      await jane.copies.update(copy.id, { locationId: omarsHome.id }),
      'Location not found',
    );
    const stored = await PhysicalCopyModel.findById(copy.id).lean();
    expect(stored?.bookId.toHexString()).toBe(book.id);
    expect(stored?.ownerId.toHexString()).toBe(jane.userId);
    expect(stored?.locationId).toBeNull();
  });

  it.each<[string, object]>([
    ['an empty change set', {}],
    ['an unknown condition', { condition: 'mint' }],
    ['a blank label', { label: ' ' }],
    ['an unknown field', { isAvailable: true }],
  ])('rejects %s', async (_label, changes) => {
    const reader = await signInLibraryReader(createAuthTestApp());
    const book = await addPhysicalBook(reader);
    const copy = await addCopy(reader, book.id, { label: 'Copy 1' });

    const res = await reader.copies.update(copy.id, changes);

    expect(res.status).toBe(400);
    expect((await reader.copies.get(copy.id)).body.data).toEqual(copy);
  });

  it('hides another reader’s copy behind the same 404 as a missing one', async () => {
    const app = createAuthTestApp();
    const jane = await signInLibraryReader(app);
    const omar = await signInLibraryReader(app);
    const copy = await addCopy(jane, (await addPhysicalBook(jane)).id, { label: 'Mine' });

    for (const copyId of [copy.id, UNUSED_ID]) {
      expectNotFound(await omar.copies.get(copyId), 'Copy not found');
      expectNotFound(await omar.copies.update(copyId, { label: 'Stolen' }), 'Copy not found');
      expectNotFound(await omar.copies.remove(copyId), 'Copy not found');
    }
    expect((await jane.copies.get(copy.id)).body.data).toEqual(copy);
  });

  it('soft-deletes a copy and hides it from every endpoint', async () => {
    const reader = await signInLibraryReader(createAuthTestApp());
    const book = await addPhysicalBook(reader);
    const copy = await addCopy(reader, book.id, { label: 'Copy 1' });

    const res = await reader.copies.remove(copy.id);

    expect(res.status).toBe(204);
    expect(res.text).toBe('');
    expectNotFound(await reader.copies.get(copy.id), 'Copy not found');
    expectNotFound(await reader.copies.update(copy.id, { label: 'Back' }), 'Copy not found');
    expectNotFound(await reader.copies.remove(copy.id), 'Copy not found');
    expect(copiesFrom(await reader.copies.listForBook(book.id))).toEqual([]);
    const stored = await PhysicalCopyModel.findById(copy.id).lean();
    expect(stored?.deletedAt).toBeInstanceOf(Date);
    expect(stored?.label).toBe('Copy 1');
  });
});

describe('parent book lifecycle', () => {
  it('keeps copy records when the book is deleted but hides them everywhere', async () => {
    const reader = await signInLibraryReader(createAuthTestApp());
    const book = await addPhysicalBook(reader);
    const home = await addLocation(reader, 'Home');
    const copy = await addCopy(reader, book.id, { label: 'Copy 1', locationId: home.id });

    expect((await reader.books.remove(book.id)).status).toBe(204);

    expectNotFound(await reader.copies.get(copy.id), 'Copy not found');
    expectNotFound(await reader.copies.update(copy.id, { label: 'x' }), 'Copy not found');
    expectNotFound(await reader.copies.remove(copy.id), 'Copy not found');
    expectNotFound(await reader.copies.listForBook(book.id), 'Book not found');
    const stored = await PhysicalCopyModel.findById(copy.id).lean();
    expect(stored).toMatchObject({ deletedAt: null, label: 'Copy 1' });
    expect(stored?.locationId?.toHexString()).toBe(home.id);
  });

  it('refuses to make a book with copies an ebook, even after the copies are deleted', async () => {
    const reader = await signInLibraryReader(createAuthTestApp());
    const book = await addPhysicalBook(reader);
    const copy = await addCopy(reader, book.id);

    const withCopy = await reader.books.update(book.id, { format: 'ebook' });
    await reader.copies.remove(copy.id);
    const afterDeletion = await reader.books.update(book.id, { format: 'ebook', title: 'Renamed' });

    for (const res of [withCopy, afterDeletion]) {
      expect(res.status).toBe(409);
      expect(res.body).toEqual({
        error: {
          code: 'BOOK_HAS_PHYSICAL_COPIES',
          message: 'A book with physical copies cannot become an ebook',
          requestId: res.headers['x-request-id'],
        },
      });
    }
    const unchanged = (await reader.books.get(book.id)).body.data as {
      format: string;
      title: string;
    };
    expect(unchanged).toMatchObject({ format: 'physical', title: 'The Hobbit' });
  });

  it('still lets a book without copy history change format, and leaves its timestamps alone when copies are added', async () => {
    const reader = await signInLibraryReader(createAuthTestApp());
    const book = await addPhysicalBook(reader);
    const other = await addPhysicalBook(reader, 'Dune');

    const toEbook = await reader.books.update(book.id, { format: 'ebook' });
    const backToPhysical = await reader.books.update(book.id, { format: 'physical' });
    await addCopy(reader, other.id);

    expect(toEbook.status).toBe(200);
    expect(backToPhysical.status).toBe(200);
    expect((await reader.books.get(other.id)).body.data).toEqual(other);
    expect(Object.keys((await reader.books.get(other.id)).body.data as object)).not.toContain(
      'hasPhysicalCopyHistory',
    );
  });

  it('returns 404 rather than 409 when changing the format of another reader’s book', async () => {
    const app = createAuthTestApp();
    const jane = await signInLibraryReader(app);
    const omar = await signInLibraryReader(app);
    const book = await addPhysicalBook(jane);
    await addCopy(jane, book.id);

    expectNotFound(await omar.books.update(book.id, { format: 'ebook' }), 'Book not found');
  });
});
