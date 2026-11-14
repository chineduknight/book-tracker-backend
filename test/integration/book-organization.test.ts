import { describe, expect, it } from 'vitest';
import { createAuthTestApp } from './auth-fixtures.js';
import {
  addEbook,
  addGroup,
  addPhysicalBook,
  expectNotFound,
  groupFrom,
  invalidFieldsOf,
  organizationFrom,
  putBookInGroup,
  signInLibraryReader,
  UNUSED_ID,
} from './library-fixtures.js';

describe('GET /api/v1/books/:bookId/organization', () => {
  it('returns empty lists for a book in no groups', async () => {
    const reader = await signInLibraryReader(createAuthTestApp());
    const book = await addPhysicalBook(reader);
    await addGroup(reader.categories, 'Fiction');

    const res = await reader.organizationOf(book.id);

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toEqual({ data: { bookId: book.id, categories: [], collections: [] } });
  });

  it('lists the active groups containing the book alphabetically, for ebooks too', async () => {
    const reader = await signInLibraryReader(createAuthTestApp());
    const ebook = await addEbook(reader);
    const other = await addPhysicalBook(reader);
    const science = await addGroup(reader.categories, 'Science');
    const fiction = await addGroup(reader.categories, 'fiction', 'Made up');
    const unrelated = await addGroup(reader.categories, 'Unrelated');
    const deleted = await addGroup(reader.categories, 'Archived');
    const favourites = await addGroup(reader.collections, 'Favourites');
    for (const group of [science, fiction, deleted]) {
      await putBookInGroup(reader.categories, group.id, ebook.id);
    }
    await putBookInGroup(reader.categories, unrelated.id, other.id);
    await putBookInGroup(reader.collections, favourites.id, ebook.id);
    await reader.categories.remove(deleted.id);

    const organization = organizationFrom(await reader.organizationOf(ebook.id));

    expect(organization).toEqual({
      bookId: ebook.id,
      categories: [
        groupFrom(await reader.categories.get(fiction.id)),
        groupFrom(await reader.categories.get(science.id)),
      ],
      collections: [groupFrom(await reader.collections.get(favourites.id))],
    });
    expect(organization.categories[0]).toMatchObject({ name: 'fiction', description: 'Made up' });
    expect(Date.parse(organization.categories[0]!.updatedAt)).toBeGreaterThan(
      Date.parse(fiction.updatedAt),
    );
    expect(organizationFrom(await reader.organizationOf(other.id))).toEqual({
      bookId: other.id,
      categories: [groupFrom(await reader.categories.get(unrelated.id))],
      collections: [],
    });
  });

  it('responds 404 "Book not found" for missing, foreign and deleted books', async () => {
    const app = createAuthTestApp();
    const reader = await signInLibraryReader(app);
    const otherReader = await signInLibraryReader(app);
    const foreign = await addPhysicalBook(otherReader);
    const theirs = await addGroup(otherReader.collections, 'Theirs');
    await putBookInGroup(otherReader.collections, theirs.id, foreign.id);
    const deleted = await addPhysicalBook(reader);
    const mine = await addGroup(reader.collections, 'Mine');
    await putBookInGroup(reader.collections, mine.id, deleted.id);
    await reader.books.remove(deleted.id);

    for (const bookId of [UNUSED_ID, foreign.id, deleted.id]) {
      expectNotFound(await reader.organizationOf(bookId), 'Book not found');
    }
    expect(invalidFieldsOf(await reader.organizationOf('abc'))).toEqual(['bookId']);
  });
});
