import { describe, expect, it } from 'vitest';
import { CategoryModel } from '../../src/modules/categories/category.model.js';
import { BookCollectionModel } from '../../src/modules/collections/collection.model.js';
import { createAuthTestApp } from './auth-fixtures.js';
import {
  addGroup,
  addPhysicalBook,
  booksFrom,
  expectNotFound,
  GROUP_KINDS,
  groupFrom,
  paginationOf,
  putBookInGroup,
  signInLibraryReader,
  type GroupKind,
} from './library-fixtures.js';

const MODELS = { categories: CategoryModel, collections: BookCollectionModel } as const;
const ROUNDS = 8;

async function stored(kind: GroupKind, groupId: string) {
  return MODELS[kind].findById(groupId).orFail().lean();
}

describe.each(GROUP_KINDS)('concurrent %s changes', (_label, kind, notFoundMessage) => {
  it('lets the unique index pick exactly one winner among concurrent creates of one name', async () => {
    const reader = await signInLibraryReader(createAuthTestApp());

    const responses = await Promise.all(
      ['Fiction', 'fiction', ' FICTION ', 'Fiction', 'fIcTiOn'].map((name) =>
        reader[kind].create({ name }),
      ),
    );

    expect(responses.map((res) => res.status).sort()).toEqual([201, 409, 409, 409, 409]);
    expect(await MODELS[kind].countDocuments()).toBe(1);
  });

  it('lets at most one of several groups take a name through concurrent renames', async () => {
    const reader = await signInLibraryReader(createAuthTestApp());
    const groups = await Promise.all(
      ['A', 'B', 'C', 'D'].map((name) => addGroup(reader[kind], name)),
    );

    const responses = await Promise.all(
      groups.map((group) => reader[kind].update(group.id, { name: 'Winner' })),
    );

    const winners = responses.filter((res) => res.status === 200);
    expect(winners).toHaveLength(1);
    expect(responses.filter((res) => res.status === 409)).toHaveLength(3);
    expect(await MODELS[kind].countDocuments({ normalizedName: 'winner', deletedAt: null })).toBe(
      1,
    );
    expect(groupFrom(winners[0]!).name).toBe('Winner');
  });

  it('stores one membership when the same book is added concurrently', async () => {
    const reader = await signInLibraryReader(createAuthTestApp());
    const group = await addGroup(reader[kind], 'Shelf');
    const book = await addPhysicalBook(reader);

    const responses = await Promise.all(
      Array.from({ length: 6 }, () => reader[kind].addBook(group.id, book.id)),
    );

    expect(responses.map((res) => res.status)).toEqual([204, 204, 204, 204, 204, 204]);
    expect((await stored(kind, group.id)).bookIds.map(String)).toEqual([book.id]);
  });

  it('loses no membership when different books are added and removed concurrently', async () => {
    const reader = await signInLibraryReader(createAuthTestApp());
    const group = await addGroup(reader[kind], 'Shelf');
    const books = [];
    for (let index = 0; index < 6; index += 1)
      books.push(await addPhysicalBook(reader, `B${index}`));
    await putBookInGroup(reader[kind], group.id, books[5]!.id);

    const responses = await Promise.all([
      ...books.slice(0, 5).map((book) => reader[kind].addBook(group.id, book.id)),
      reader[kind].removeBook(group.id, books[5]!.id),
    ]);

    expect(responses.every((res) => res.status === 204)).toBe(true);
    const memberIds = booksFrom(await reader[kind].listBooks(group.id)).map((book) => book.id);
    expect([...memberIds].sort()).toEqual(
      books
        .slice(0, 5)
        .map((book) => book.id)
        .sort(),
    );
  });

  it('never shows a book that is deleted while being added, and never cascades', async () => {
    const reader = await signInLibraryReader(createAuthTestApp());
    const group = await addGroup(reader[kind], 'Shelf');

    for (let round = 0; round < ROUNDS; round += 1) {
      const book = await addPhysicalBook(reader, `Race ${round}`);

      const [removal, addition] = await Promise.all([
        reader.books.remove(book.id),
        reader[kind].addBook(group.id, book.id),
      ]);

      expect(removal.status).toBe(204);
      expect([204, 404]).toContain(addition.status);
      expect((await reader.books.get(book.id)).status).toBe(404);
      expect(booksFrom(await reader[kind].listBooks(group.id))).toEqual([]);
      expect(paginationOf(await reader[kind].listBooks(group.id)).total).toBe(0);
    }
    expect((await reader[kind].get(group.id)).status).toBe(200);
  });

  it('never resurrects a group deleted while a book is being added to it', async () => {
    const reader = await signInLibraryReader(createAuthTestApp());
    const book = await addPhysicalBook(reader);

    for (let round = 0; round < ROUNDS; round += 1) {
      const group = await addGroup(reader[kind], `Shelf ${round}`);

      const [removal, addition] = await Promise.all([
        reader[kind].remove(group.id),
        reader[kind].addBook(group.id, book.id),
      ]);

      expect(removal.status).toBe(204);
      expect([204, 404]).toContain(addition.status);
      expect((await stored(kind, group.id)).deletedAt).toBeInstanceOf(Date);
      expectNotFound(await reader[kind].get(group.id), notFoundMessage);
      expect((await reader.organizationOf(book.id)).body.data[kind]).toEqual([]);
    }
  });
});
