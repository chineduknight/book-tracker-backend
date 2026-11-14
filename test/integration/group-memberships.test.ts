import { describe, expect, it } from 'vitest';
import type { BookDto } from '../../src/modules/books/book.dto.js';
import { CategoryModel } from '../../src/modules/categories/category.model.js';
import { BookCollectionModel } from '../../src/modules/collections/collection.model.js';
import { collectKeys, createAuthTestApp } from './auth-fixtures.js';
import { BOOK_DTO_KEYS } from './book-fixtures.js';
import {
  addEbook,
  addGroup,
  addPhysicalBook,
  booksFrom,
  expectNotFound,
  GROUP_KINDS,
  invalidFieldsOf,
  paginationOf,
  putBookInGroup,
  signInLibraryReader,
  UNUSED_ID,
  type GroupKind,
  type LibraryReader,
} from './library-fixtures.js';

const MODELS = { categories: CategoryModel, collections: BookCollectionModel } as const;

async function storedBookIds(kind: GroupKind, groupId: string) {
  const group = await MODELS[kind].findById(groupId).orFail().lean();
  return group.bookIds.map((id) => id.toHexString());
}

function idsOf(res: { body: unknown }) {
  return booksFrom(res).map((book) => book.id);
}

async function addBooks(reader: LibraryReader, count: number, prefix = 'Book') {
  const books: BookDto[] = [];
  for (let index = 0; index < count; index += 1) {
    books.push(await addPhysicalBook(reader, `${prefix} ${index}`));
  }
  return books;
}

describe.each(GROUP_KINDS)('%s memberships', (label, kind, notFoundMessage) => {
  it('adds a book idempotently and lists it as a full BookDto', async () => {
    const reader = await signInLibraryReader(createAuthTestApp());
    const group = await addGroup(reader[kind], 'Shelf');
    const book = await addPhysicalBook(reader);

    const first = await reader[kind].addBook(group.id, book.id);
    const again = await reader[kind].addBook(group.id, book.id);
    const listed = await reader[kind].listBooks(group.id);

    for (const res of [first, again]) {
      expect(res.status).toBe(204);
      expect(res.text).toBe('');
      expect(res.headers['cache-control']).toBe('no-store');
    }
    expect(await storedBookIds(kind, group.id)).toEqual([book.id]);
    expect(listed.status).toBe(200);
    expect(booksFrom(listed)).toEqual([book]);
    expect(Object.keys(booksFrom(listed)[0] ?? {}).sort()).toEqual(
      BOOK_DTO_KEYS.filter((key) => key in book).sort(),
    );
    expect(paginationOf(listed)).toEqual({ page: 1, limit: 20, total: 1, totalPages: 1 });
    const keys = collectKeys(listed.body);
    for (const internal of ['bookIds', 'ownerId', '_id', 'deletedAt']) {
      expect(keys.has(internal)).toBe(false);
    }
  });

  it('removes a book idempotently, and re-adding appends it at the end', async () => {
    const reader = await signInLibraryReader(createAuthTestApp());
    const group = await addGroup(reader[kind], 'Shelf');
    const [first, second, third] = await addBooks(reader, 3);
    for (const book of [first, second, third])
      await putBookInGroup(reader[kind], group.id, book!.id);

    const removal = await reader[kind].removeBook(group.id, first!.id);
    const again = await reader[kind].removeBook(group.id, first!.id);
    await putBookInGroup(reader[kind], group.id, first!.id);
    await putBookInGroup(reader[kind], group.id, second!.id);

    expect(removal.status).toBe(204);
    expect(again.status).toBe(204);
    expect(again.text).toBe('');
    expect(idsOf(await reader[kind].listBooks(group.id))).toEqual([
      second!.id,
      third!.id,
      first!.id,
    ]);
  });

  it('keeps membership order rather than book creation order, across pages', async () => {
    const reader = await signInLibraryReader(createAuthTestApp());
    const group = await addGroup(reader[kind], 'Shelf');
    const books = await addBooks(reader, 5);
    const membershipOrder = [books[3], books[0], books[4], books[1], books[2]].map((b) => b!.id);
    for (const bookId of membershipOrder) await putBookInGroup(reader[kind], group.id, bookId);

    const pages = await Promise.all(
      ['1', '2', '3'].map((page) => reader[kind].listBooks(group.id, { limit: '2', page })),
    );

    expect(pages.flatMap(idsOf)).toEqual(membershipOrder);
    expect(paginationOf(pages[0]!)).toEqual({ page: 1, limit: 2, total: 5, totalPages: 3 });
    expect(idsOf(await reader[kind].listBooks(group.id, { page: '4', limit: '2' }))).toEqual([]);
  });

  it('hides deleted books before counting and paging, leaving no gaps', async () => {
    const reader = await signInLibraryReader(createAuthTestApp());
    const group = await addGroup(reader[kind], 'Shelf');
    const books = await addBooks(reader, 8);
    for (const book of books) await putBookInGroup(reader[kind], group.id, book.id);
    for (const index of [0, 3, 4, 7]) await reader.books.remove(books[index]!.id);
    const visible = [1, 2, 5, 6].map((index) => books[index]!.id);

    const pages = await Promise.all(
      ['1', '2', '3'].map((page) => reader[kind].listBooks(group.id, { limit: '2', page })),
    );

    expect(pages.map(idsOf)).toEqual([visible.slice(0, 2), visible.slice(2), []]);
    for (const page of pages) {
      expect(paginationOf(page)).toMatchObject({ total: 4, totalPages: 2 });
    }
    expect(await storedBookIds(kind, group.id)).toHaveLength(8);
  });

  it('never lists a planted foreign book id and still counts only visible ones', async () => {
    const app = createAuthTestApp();
    const reader = await signInLibraryReader(app);
    const otherReader = await signInLibraryReader(app);
    const group = await addGroup(reader[kind], 'Shelf');
    const mine = await addPhysicalBook(reader);
    const theirs = await addPhysicalBook(otherReader, 'Theirs');
    await putBookInGroup(reader[kind], group.id, mine.id);
    await MODELS[kind].updateOne({ _id: group.id }, { $push: { bookIds: theirs.id } });

    const listed = await reader[kind].listBooks(group.id);

    expect(idsOf(listed)).toEqual([mine.id]);
    expect(paginationOf(listed).total).toBe(1);
    expect(await storedBookIds(kind, group.id)).toEqual([mine.id, theirs.id]);
  });

  it('works for ebooks, several groups per book and books with identical titles', async () => {
    const reader = await signInLibraryReader(createAuthTestApp());
    const shelfA = await addGroup(reader[kind], 'Shelf A');
    const shelfB = await addGroup(reader[kind], 'Shelf B');
    const ebook = await addEbook(reader, 'Same Title');
    const paper = await addPhysicalBook(reader, 'Same Title');
    for (const group of [shelfA, shelfB]) await putBookInGroup(reader[kind], group.id, ebook.id);
    await putBookInGroup(reader[kind], shelfA.id, paper.id);

    expect(idsOf(await reader[kind].listBooks(shelfA.id))).toEqual([ebook.id, paper.id]);
    expect(idsOf(await reader[kind].listBooks(shelfB.id))).toEqual([ebook.id]);
    await reader[kind].removeBook(shelfA.id, paper.id);
    expect(idsOf(await reader[kind].listBooks(shelfA.id))).toEqual([ebook.id]);
    expect((await reader.books.get(paper.id)).status).toBe(200);
  });

  it('does not change the book itself when it joins or leaves a group', async () => {
    const reader = await signInLibraryReader(createAuthTestApp());
    const group = await addGroup(reader[kind], 'Shelf');
    const book = await addPhysicalBook(reader);

    await putBookInGroup(reader[kind], group.id, book.id);
    await reader[kind].removeBook(group.id, book.id);

    expect((await reader.books.get(book.id)).body.data).toEqual(book);
    expect((await reader.books.list()).body.data).toEqual([book]);
  });

  it.each([
    ['a missing book', () => Promise.resolve(UNUSED_ID)],
    [
      'another reader’s book',
      async (app: Parameters<typeof signInLibraryReader>[0]) =>
        (await addPhysicalBook(await signInLibraryReader(app))).id,
    ],
    [
      'a deleted book',
      async (_app: unknown, reader: LibraryReader) => {
        const book = await addPhysicalBook(reader);
        await reader.books.remove(book.id);
        return book.id;
      },
    ],
  ])(
    'responds 404 "Book not found" for %s on add and remove, storing nothing',
    async (_l, bookIdFor) => {
      const app = createAuthTestApp();
      const reader = await signInLibraryReader(app);
      const group = await addGroup(reader[kind], 'Shelf');
      const bookId = await bookIdFor(app, reader);

      expectNotFound(await reader[kind].addBook(group.id, bookId), 'Book not found');
      expectNotFound(await reader[kind].removeBook(group.id, bookId), 'Book not found');
      expect(await storedBookIds(kind, group.id)).toEqual([]);
    },
  );

  it('checks the book before the group, so both unknown reports the book', async () => {
    const reader = await signInLibraryReader(createAuthTestApp());

    expectNotFound(await reader[kind].addBook(UNUSED_ID, UNUSED_ID), 'Book not found');
    expectNotFound(await reader[kind].removeBook(UNUSED_ID, UNUSED_ID), 'Book not found');
  });

  it('rejects malformed ids naming the parameter', async () => {
    const reader = await signInLibraryReader(createAuthTestApp());
    const group = await addGroup(reader[kind], 'Shelf');

    expect(invalidFieldsOf(await reader[kind].addBook(group.id, 'abc'))).toEqual(['bookId']);
    expect(invalidFieldsOf(await reader[kind].removeBook('abc', UNUSED_ID))).toEqual([
      `${label}Id`,
    ]);
    expect(invalidFieldsOf(await reader[kind].listBooks(group.id, { limit: '0' }))).toEqual([
      'limit',
    ]);
  });

  it('hides a planted group whose owner differs from the reader even for the reader’s book', async () => {
    const app = createAuthTestApp();
    const reader = await signInLibraryReader(app);
    const otherReader = await signInLibraryReader(app);
    const book = await addPhysicalBook(reader);
    const planted = await MODELS[kind].create({
      ownerId: otherReader.userId,
      name: 'Planted',
      normalizedName: 'planted',
      bookIds: [book.id],
    });
    const plantedId = planted._id.toHexString();

    expectNotFound(await reader[kind].get(plantedId), notFoundMessage);
    expectNotFound(await reader[kind].listBooks(plantedId), notFoundMessage);
    expectNotFound(await reader[kind].removeBook(plantedId, book.id), notFoundMessage);
    expect((await reader.organizationOf(book.id)).body.data[kind]).toEqual([]);
    expect((await reader[kind].list()).body.data).toEqual([]);
  });
});
