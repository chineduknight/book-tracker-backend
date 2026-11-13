import request from 'supertest';
import { describe, expect, it } from 'vitest';
import {
  normalizeIsbnForMatching,
  normalizeTitleForMatching,
} from '../src/modules/books/book.normalization.js';
import { toTextSearchWords } from '../src/shared/text.js';
import {
  bookIdParamsSchema,
  createBookRequestSchema,
  duplicateCheckQuerySchema,
  listBooksQuerySchema,
  updateBookRequestSchema,
} from '../src/modules/books/book.schema.js';
import { createTestApp } from './helpers.js';

const minimalBook = { title: 'The Hobbit', format: 'physical' };

function issuesOf(result: { success: boolean; error?: { issues: unknown[] } }) {
  return (result.error?.issues ?? []) as { path: PropertyKey[]; message: string; code: string }[];
}

describe('book normalization', () => {
  it('matches titles regardless of case and spacing but keeps punctuation', () => {
    expect(normalizeTitleForMatching('  The   HOBBIT ')).toBe('the hobbit');
    expect(normalizeTitleForMatching('Dune: Messiah!')).toBe('dune: messiah!');
    expect(normalizeTitleForMatching('Dune: Messiah!')).not.toBe(
      normalizeTitleForMatching('Dune Messiah'),
    );
  });

  it('composes Unicode so visually identical titles match', () => {
    expect(normalizeTitleForMatching('Café')).toBe(normalizeTitleForMatching('Café'));
  });

  it('ignores spaces, hyphens and case in ISBNs', () => {
    expect(normalizeIsbnForMatching('978-0 261-10221-4')).toBe('9780261102214');
    expect(normalizeIsbnForMatching('0-8044-2957-x')).toBe('080442957X');
  });

  it('turns search text into plain words without phrase or negation operators', () => {
    expect(toTextSearchWords(' "lord of" the -rings  Jean-Paul ')).toBe(
      'lord of the rings Jean Paul',
    );
  });
});

describe('createBookRequestSchema', () => {
  it('accepts a minimal book and leaves optional fields absent', () => {
    expect(createBookRequestSchema.parse(minimalBook)).toEqual(minimalBook);
  });

  it('trims and collapses the title and trims other text', () => {
    const book = createBookRequestSchema.parse({
      ...minimalBook,
      title: '  The \n  Hobbit ',
      authors: ['  J. R. R. Tolkien '],
      isbn: ' 978-0261102214 ',
      edition: ' First ',
      description: '  A journey.\n\nThere and back. ',
    });

    expect(book).toMatchObject({
      title: 'The Hobbit',
      authors: ['J. R. R. Tolkien'],
      isbn: '978-0261102214',
      edition: 'First',
      description: 'A journey.\n\nThere and back.',
    });
  });

  it.each([
    'ownerId',
    'userId',
    '_id',
    'id',
    'deletedAt',
    'normalizedTitle',
    'normalizedIsbn',
    'readingStatus',
    'copyCount',
    'createdAt',
  ])('rejects the client-supplied field %s', (field) => {
    const result = createBookRequestSchema.safeParse({ ...minimalBook, [field]: 'x' });

    expect(result.success).toBe(false);
    expect(issuesOf(result)[0]).toMatchObject({ code: 'unrecognized_keys' });
  });

  it.each<[string, Record<string, unknown>]>([
    ['a blank title', { title: '   ' }],
    ['a title over 250 characters', { title: 't'.repeat(251) }],
    ['an unknown format', { format: 'audiobook' }],
    ['a blank author', { authors: ['Tolkien', '  '] }],
    ['more than 20 authors', { authors: Array.from({ length: 21 }, (_, index) => `A${index}`) }],
    ['an author over 120 characters', { authors: ['a'.repeat(121)] }],
    ['a blank isbn', { isbn: '  ' }],
    ['an isbn of only separators', { isbn: '- -' }],
    ['an isbn over 32 characters', { isbn: '9'.repeat(33) }],
    ['a blank edition', { edition: ' ' }],
    ['a description over 5000 characters', { description: 'd'.repeat(5_001) }],
    ['a relative cover URL', { coverUrl: '/covers/hobbit.jpg' }],
    ['a non-http cover URL', { coverUrl: 'ftp://example.com/hobbit.jpg' }],
    ['a javascript cover URL', { coverUrl: 'javascript:alert(1)' }],
    ['a cover URL over 2048 characters', { coverUrl: `https://example.com/${'a'.repeat(2_048)}` }],
    ['a zero page count', { pageCount: 0 }],
    ['a fractional page count', { pageCount: 10.5 }],
    ['a page count given as text', { pageCount: '300' }],
    ['a page count over 100000', { pageCount: 100_001 }],
    ['a chapter count over 10000', { chapterCount: 10_001 }],
    ['a publication year of 0', { publicationYear: 0 }],
    ['a publication year over 9999', { publicationYear: 10_000 }],
    ['a null optional field', { isbn: null }],
  ])('rejects %s', (_label, override) => {
    expect(createBookRequestSchema.safeParse({ ...minimalBook, ...override }).success).toBe(false);
  });

  it('requires title and format', () => {
    const fields = issuesOf(createBookRequestSchema.safeParse({})).map((issue) =>
      issue.path.join('.'),
    );

    expect(fields).toEqual(['title', 'format']);
  });
});

describe('updateBookRequestSchema', () => {
  it('rejects an empty change set', () => {
    const result = updateBookRequestSchema.safeParse({});

    expect(issuesOf(result)).toEqual([
      expect.objectContaining({ path: [], message: 'must change at least one field' }),
    ]);
  });

  it('accepts null to clear optional fields and an empty author list', () => {
    const changes = {
      isbn: null,
      edition: null,
      description: null,
      coverUrl: null,
      pageCount: null,
      chapterCount: null,
      publicationYear: null,
      authors: [],
    };

    expect(updateBookRequestSchema.parse(changes)).toEqual(changes);
  });

  it.each(['title', 'format', 'authors'])('rejects null for %s', (field) => {
    expect(updateBookRequestSchema.safeParse({ [field]: null }).success).toBe(false);
  });

  it('rejects forbidden fields', () => {
    expect(updateBookRequestSchema.safeParse({ title: 'Dune', ownerId: 'x' }).success).toBe(false);
  });
});

describe('listBooksQuerySchema', () => {
  it('applies defaults', () => {
    expect(listBooksQuerySchema.parse({})).toEqual({ page: 1, limit: 20, sort: 'recent' });
  });

  it('parses every supported parameter', () => {
    expect(
      listBooksQuerySchema.parse({
        page: '3',
        limit: '100',
        q: ' tolkien ',
        format: 'ebook',
        sort: 'title_desc',
      }),
    ).toEqual({ page: 3, limit: 100, q: 'tolkien', format: 'ebook', sort: 'title_desc' });
  });

  it.each(['page', 'limit', 'q', 'format', 'sort'])('rejects a repeated %s', (name) => {
    const result = listBooksQuerySchema.safeParse({ [name]: ['1', '2'] });

    expect(issuesOf(result)).toEqual([
      expect.objectContaining({ path: [name], message: 'must be given only once' }),
    ]);
  });

  it.each<[string, Record<string, string>]>([
    ['page 0', { page: '0' }],
    ['a negative page', { page: '-1' }],
    ['a page with a leading zero', { page: '01' }],
    ['a fractional page', { page: '1.5' }],
    ['a page beyond safe integers', { page: '9007199254740993' }],
    ['limit 0', { limit: '0' }],
    ['limit 101', { limit: '101' }],
    ['an unknown format', { format: 'audiobook' }],
    ['an unknown sort', { sort: 'popular' }],
    ['a blank search', { q: '   ' }],
    ['a punctuation-only search', { q: '"-"' }],
    ['a search over 120 characters', { q: 'q'.repeat(121) }],
    ['an unknown parameter', { ownerId: '64b7f0c2a1b2c3d4e5f60718' }],
  ])('rejects %s', (_label, query) => {
    expect(listBooksQuerySchema.safeParse(query).success).toBe(false);
  });
});

describe('duplicateCheckQuerySchema', () => {
  it('requires a title or an isbn', () => {
    expect(issuesOf(duplicateCheckQuerySchema.safeParse({}))).toEqual([
      expect.objectContaining({ message: 'provide a title, an isbn or both' }),
    ]);
  });

  it.each<[string, Record<string, unknown>]>([
    ['a blank title', { title: '  ' }],
    ['a blank isbn', { isbn: ' ' }],
    ['a repeated title', { title: ['a', 'b'] }],
    ['an unknown parameter', { title: 'Dune', ownerId: 'x' }],
  ])('rejects %s', (_label, query) => {
    expect(duplicateCheckQuerySchema.safeParse(query).success).toBe(false);
  });
});

describe('bookIdParamsSchema', () => {
  it.each(['64b7f0c2a1b2c3d4e5f60718', '64B7F0C2A1B2C3D4E5F60718'])('accepts %s', (bookId) => {
    expect(bookIdParamsSchema.safeParse({ bookId }).success).toBe(true);
  });

  it.each(['123', 'not-an-id', '64b7f0c2a1b2c3d4e5f6071g', '64b7f0c2a1b2c3d4e5f607181'])(
    'rejects %s',
    (bookId) => {
      expect(issuesOf(bookIdParamsSchema.safeParse({ bookId }))).toEqual([
        expect.objectContaining({
          path: ['bookId'],
          message: 'must be a 24-character hexadecimal id',
        }),
      ]);
    },
  );
});

describe('books endpoints without authentication', () => {
  const BOOK_ID = '64b7f0c2a1b2c3d4e5f60718';

  it.each([
    ['POST', '/api/v1/books'],
    ['GET', '/api/v1/books'],
    ['GET', '/api/v1/books/duplicate-check?title=Dune'],
    ['GET', `/api/v1/books/${BOOK_ID}`],
    ['PATCH', `/api/v1/books/${BOOK_ID}`],
    ['DELETE', `/api/v1/books/${BOOK_ID}`],
  ])('%s %s returns 401 UNAUTHENTICATED', async (method, path) => {
    const res = await request(createTestApp())[method.toLowerCase() as 'get'](path).send({});

    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toBe('Bearer');
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });
});
