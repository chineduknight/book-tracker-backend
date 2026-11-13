import { describe, expect, it } from 'vitest';
import { createAuthTestApp } from './auth-fixtures.js';
import {
  addEbook,
  addNote,
  addPhysicalBook,
  notesFrom,
  paginationOf,
  signInLibraryReader,
  type LibraryReader,
} from './library-fixtures.js';

async function contentsFound(reader: LibraryReader, query: Record<string, string>) {
  const res = await reader.notes.listAll(query);
  expect(res.status).toBe(200);
  return notesFrom(res)
    .map((note) => note.content)
    .sort();
}

async function signInWithSearchableNotes() {
  const reader = await signInLibraryReader(createAuthTestApp());
  const book = await addPhysicalBook(reader);
  await addNote(reader, book.id, { kind: 'note', content: 'Plain', title: 'Mirkwood journey' });
  await addNote(reader, book.id, { kind: 'note', content: 'The dragons sleep under the mountain' });
  await addNote(reader, book.id, {
    kind: 'highlight',
    content: 'Quoted',
    commentary: 'Smaug is vain',
  });
  await addNote(reader, book.id, { kind: 'note', content: 'Chaptered', chapter: 'Lake-town' });
  await addNote(reader, book.id, { kind: 'note', content: 'Café Society meets at dawn' });
  return { reader, book };
}

describe('note text search', () => {
  it.each([
    ['title', 'mirkwood', ['Plain']],
    ['content', 'mountain', ['The dragons sleep under the mountain']],
    ['commentary', 'smaug', ['Quoted']],
    ['chapter', 'lake', ['Chaptered']],
  ])('finds words in the %s', async (_field, q, expected) => {
    const { reader } = await signInWithSearchableNotes();

    expect(await contentsFound(reader, { q })).toEqual(expected);
  });

  it('ignores case and diacritics', async () => {
    const { reader } = await signInWithSearchableNotes();

    for (const q of ['cafe', 'CAFÉ', 'Café', 'SOCIETY']) {
      expect(await contentsFound(reader, { q })).toEqual(['Café Society meets at dawn']);
    }
  });

  it('matches whole terms, not prefixes or patterns', async () => {
    const { reader } = await signInWithSearchableNotes();

    for (const q of ['drag', 'drag.*', 'dragon[s]?', '^Th', 'mount']) {
      expect({ q, found: await contentsFound(reader, { q }) }).toEqual({ q, found: [] });
    }
    expect(await contentsFound(reader, { q: 'dragons' })).toEqual([
      'The dragons sleep under the mountain',
    ]);
  });

  it('matches any of several words', async () => {
    const { reader } = await signInWithSearchableNotes();

    expect(await contentsFound(reader, { q: 'smaug mirkwood' })).toEqual(['Plain', 'Quoted']);
  });

  it('treats quotes and leading hyphens as plain text, not phrase or negation operators', async () => {
    const { reader } = await signInWithSearchableNotes();

    expect(await contentsFound(reader, { q: '-smaug' })).toEqual(['Quoted']);
    expect(await contentsFound(reader, { q: 'mirkwood -smaug' })).toEqual(['Plain', 'Quoted']);
    expect(await contentsFound(reader, { q: '"smaug vain mountain"' })).toEqual([
      'Quoted',
      'The dragons sleep under the mountain',
    ]);
  });

  it('combines search with kind, book and chapter filters and counts only matches', async () => {
    const { reader, book } = await signInWithSearchableNotes();
    const ebook = await addEbook(reader);
    await addNote(reader, ebook.id, {
      kind: 'highlight',
      content: 'Smaug in the ebook',
      chapter: 'Inside Information',
    });

    expect(await contentsFound(reader, { q: 'smaug', kind: 'highlight' })).toEqual([
      'Quoted',
      'Smaug in the ebook',
    ]);
    expect(await contentsFound(reader, { q: 'smaug', bookId: book.id })).toEqual(['Quoted']);
    expect(await contentsFound(reader, { q: 'smaug', chapter: 'inside information' })).toEqual([
      'Smaug in the ebook',
    ]);
    const bookScoped = await reader.notes.listForBook(ebook.id, { q: 'smaug' });
    expect(notesFrom(bookScoped).map((note) => note.content)).toEqual(['Smaug in the ebook']);
    expect(paginationOf(bookScoped).total).toBe(1);
  });

  it('never finds another reader’s notes, even with identical words', async () => {
    const app = createAuthTestApp();
    const reader = await signInLibraryReader(app);
    const otherReader = await signInLibraryReader(app);
    await addNote(otherReader, (await addPhysicalBook(otherReader)).id, {
      kind: 'note',
      content: 'Arkenstone secret',
    });
    await addNote(reader, (await addPhysicalBook(reader)).id, {
      kind: 'note',
      content: 'My arkenstone',
    });

    expect(await contentsFound(reader, { q: 'arkenstone' })).toEqual(['My arkenstone']);
    expect(await contentsFound(otherReader, { q: 'arkenstone' })).toEqual(['Arkenstone secret']);
  });
});
