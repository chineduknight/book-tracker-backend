import { describe, expect, it } from 'vitest';
import { createAuthTestApp } from './auth-fixtures.js';
import { addBook, signInNewReader } from './book-fixtures.js';

function matchesFrom(res: { body: unknown }) {
  return (
    res.body as {
      data: { matches: { book: { id: string; title: string }; matchedOn: string[] }[] };
    }
  ).data.matches;
}

describe('GET /api/v1/books/duplicate-check', () => {
  it('allows duplicate titles and ISBNs to be created separately', async () => {
    const { books } = await signInNewReader(createAuthTestApp());
    const entry = { title: 'Dune', format: 'physical', isbn: '978-0441013593' };

    const first = await books.create(entry);
    const second = await books.create(entry);

    expect([first.status, second.status]).toEqual([201, 201]);
    expect(first.body.data.id).not.toBe(second.body.data.id);
  });

  it('suggests matches on normalized title and ISBN, newest first, with ordered reasons', async () => {
    const { books } = await signInNewReader(createAuthTestApp());
    const titleOnly = await addBook(books, { title: 'dune', format: 'ebook' });
    const isbnOnly = await addBook(books, {
      title: 'Dune (Deluxe)',
      format: 'physical',
      isbn: '9780441013593',
    });
    const both = await addBook(books, {
      title: '  DUNE ',
      format: 'physical',
      isbn: '978-0 441-01359-3',
    });
    await addBook(books, { title: 'Dune Messiah', format: 'physical' });

    const res = await books.duplicateCheck({ title: 'Dune', isbn: '978 0441013593' });

    expect(res.status).toBe(200);
    expect(matchesFrom(res).map((match) => [match.book.id, match.matchedOn])).toEqual([
      [both.id, ['title', 'isbn']],
      [isbnOnly.id, ['isbn']],
      [titleOnly.id, ['title']],
    ]);
    expect(matchesFrom(res)[0]?.book).toEqual(both);
  });

  it('keeps meaningful punctuation in titles', async () => {
    const { books } = await signInNewReader(createAuthTestApp());
    await addBook(books, { title: 'Dune: Messiah!', format: 'physical' });

    expect(matchesFrom(await books.duplicateCheck({ title: 'Dune Messiah' }))).toEqual([]);
    expect(matchesFrom(await books.duplicateCheck({ title: 'dune: messiah!' }))).toHaveLength(1);
  });

  it('returns at most 10 suggestions, newest first', async () => {
    const { books } = await signInNewReader(createAuthTestApp());
    const created = [];
    for (let index = 0; index < 12; index += 1) {
      created.push(await addBook(books, { title: 'Repeated Title', format: 'physical' }));
    }

    const matches = matchesFrom(await books.duplicateCheck({ title: 'repeated title' }));

    expect(matches.map((match) => match.book.id)).toEqual(
      created
        .map((book) => book.id)
        .reverse()
        .slice(0, 10),
    );
  });

  it('requires a non-blank title or isbn', async () => {
    const { books } = await signInNewReader(createAuthTestApp());

    const missing = await books.duplicateCheck('');
    const blank = await books.duplicateCheck({ title: '   ' });

    expect(missing.status).toBe(400);
    expect(missing.body.error.details).toEqual([
      { field: 'query', message: 'provide a title, an isbn or both' },
    ]);
    expect(blank.status).toBe(400);
    expect(blank.body.error.details).toEqual([{ field: 'title', message: expect.any(String) }]);
  });
});
