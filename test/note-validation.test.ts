import { Types } from 'mongoose';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { toPublicNote } from '../src/modules/notes/note.dto.js';
import type { NoteRecord } from '../src/modules/notes/note.model.js';
import { problemsWithContentLength, toChapterKey } from '../src/modules/notes/note.rules.js';
import {
  allNotesQuerySchema,
  bookNotesQuerySchema,
  createNoteRequestSchema,
  updateNoteRequestSchema,
} from '../src/modules/notes/note.schema.js';
import { createTestApp } from './helpers.js';

const SOME_ID = '64b7f0c2a1b2c3d4e5f60718';

function issuesOf(result: { success: boolean; error?: { issues: object[] } }) {
  return (result.error?.issues ?? []).map((issue) => {
    const { path, message } = issue as { path: PropertyKey[]; message: string };
    return { path: path.join('.'), message };
  });
}

describe('note content rules', () => {
  it.each([
    ['note', 20_000, []],
    [
      'note',
      20_001,
      [{ field: 'content', message: 'must be at most 20000 characters for a note' }],
    ],
    ['highlight', 5_000, []],
    [
      'highlight',
      5_001,
      [{ field: 'content', message: 'must be at most 5000 characters for a highlight' }],
    ],
  ] as const)('a %s of %i characters has problems %j', (kind, length, problems) => {
    expect(problemsWithContentLength(kind, 'x'.repeat(length))).toEqual(problems);
  });

  it('derives the same chapter key regardless of case, spacing and Unicode composition', () => {
    const composed = 'Café  Society';
    const decomposed = '  café SOCIETY ';

    expect(toChapterKey(composed)).toBe('café society');
    expect(toChapterKey(decomposed)).toBe(toChapterKey(composed));
    expect(toChapterKey('Chapter 1')).not.toBe(toChapterKey('Chapter 11'));
  });
});

describe('createNoteRequestSchema', () => {
  it('accepts a minimal note and leaves the session link unset', () => {
    expect(createNoteRequestSchema.parse({ kind: 'note', content: 'x' })).toEqual({
      kind: 'note',
      content: 'x',
    });
  });

  it('trims only the surrounding whitespace of text fields', () => {
    expect(
      createNoteRequestSchema.parse({
        kind: 'highlight',
        content: '\n  “Quoted,”  he said —\n  twice.  \n',
        title: '  A  title ',
        commentary: ' Line one\n\nLine two ',
        chapter: ' Chapter  3 ',
        pageNumber: 12,
        readingSessionId: null,
      }),
    ).toEqual({
      kind: 'highlight',
      content: '“Quoted,”  he said —\n  twice.',
      title: 'A  title',
      commentary: 'Line one\n\nLine two',
      chapter: 'Chapter  3',
      pageNumber: 12,
      readingSessionId: null,
    });
  });

  it('reports the highlight limit once, and only for otherwise valid content', () => {
    expect(
      issuesOf(
        createNoteRequestSchema.safeParse({ kind: 'highlight', content: 'x'.repeat(5_001) }),
      ),
    ).toEqual([{ path: 'content', message: 'must be at most 5000 characters for a highlight' }]);
    expect(
      issuesOf(
        createNoteRequestSchema.safeParse({ kind: 'highlight', content: 'x'.repeat(20_001) }),
      ),
    ).toEqual([
      { path: 'content', message: 'Too big: expected string to have <=20000 characters' },
    ]);
    expect(
      issuesOf(createNoteRequestSchema.safeParse({ kind: 'quote', content: 'x'.repeat(6_000) })),
    ).toEqual([{ path: 'kind', message: 'Invalid option: expected one of "note"|"highlight"' }]);
  });

  it.each([
    [{ kind: 'note', content: 'x', readingSessionId: 'abc' }, 'readingSessionId'],
    [{ kind: 'note', content: 'x', pageNumber: '12' }, 'pageNumber'],
    [{ kind: 'note', content: 'x', title: 't'.repeat(161) }, 'title'],
    [{ kind: 'note', content: 'x', chapter: 'c'.repeat(201) }, 'chapter'],
    [{ kind: 'note', content: 'x', commentary: '   ' }, 'commentary'],
    [{ kind: 'note', content: 'x', chapter: null }, 'chapter'],
  ])('rejects %j at %s', (body, field) => {
    expect(issuesOf(createNoteRequestSchema.safeParse(body)).map((issue) => issue.path)).toEqual([
      field,
    ]);
  });

  it('rejects unknown fields instead of ignoring them', () => {
    const result = createNoteRequestSchema.safeParse({
      kind: 'note',
      content: 'x',
      ownerId: SOME_ID,
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]).toMatchObject({ code: 'unrecognized_keys', keys: ['ownerId'] });
  });
});

describe('updateNoteRequestSchema', () => {
  it('accepts null to clear optional fields', () => {
    const changes = { title: null, commentary: null, chapter: null, pageNumber: null };

    expect(updateNoteRequestSchema.parse(changes)).toEqual(changes);
  });

  it.each([
    [{}, 'must change at least one field'],
    [{ content: null }, 'Invalid input: expected string, received null'],
    [{ content: '  ' }, 'Too small: expected string to have >=1 characters'],
  ])('rejects %j', (changes, message) => {
    expect(
      issuesOf(updateNoteRequestSchema.safeParse(changes)).map((issue) => issue.message),
    ).toEqual([message]);
  });

  it.each(['kind', 'readingSessionId', 'bookId', 'ownerId', 'deletedAt', 'createdAt'])(
    'rejects a change to %s',
    (field) => {
      expect(updateNoteRequestSchema.safeParse({ [field]: null, title: 'x' }).success).toBe(false);
    },
  );
});

describe('note list query schemas', () => {
  it('defaults to the first page of 20 newest notes', () => {
    expect(bookNotesQuerySchema.parse({})).toEqual({ page: 1, limit: 20, sort: 'recent' });
  });

  it('trims the search and chapter filters', () => {
    expect(bookNotesQuerySchema.parse({ q: ' dragon ', chapter: ' Chapter 1 ' })).toMatchObject({
      q: 'dragon',
      chapter: 'Chapter 1',
    });
  });

  it('accepts a book filter only on the global list', () => {
    expect(allNotesQuerySchema.parse({ bookId: SOME_ID })).toMatchObject({ bookId: SOME_ID });
    expect(bookNotesQuerySchema.safeParse({ bookId: SOME_ID }).success).toBe(false);
  });

  it.each([
    { q: '' },
    { q: '- "' },
    { q: 'q'.repeat(121) },
    { q: ['dragon', 'smaug'] },
    { chapter: '' },
    { kind: 'quote' },
    { sort: 'score' },
    { readingSessionId: 'abc' },
    { limit: '0' },
  ])('rejects %j', (query) => {
    expect(allNotesQuerySchema.safeParse(query).success).toBe(false);
  });
});

describe('toPublicNote', () => {
  const timestamp = new Date('2026-11-13T10:30:00.000Z');
  const minimalRecord = {
    _id: new Types.ObjectId(SOME_ID),
    ownerId: new Types.ObjectId(),
    bookId: new Types.ObjectId('64b7f0c2a1b2c3d4e5f60719'),
    readingSessionId: null,
    kind: 'note',
    content: 'x',
    deletedAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  } as unknown as NoteRecord;

  it('omits unset optional fields but always includes the session link', () => {
    expect(toPublicNote(minimalRecord)).toEqual({
      id: SOME_ID,
      bookId: '64b7f0c2a1b2c3d4e5f60719',
      readingSessionId: null,
      kind: 'note',
      content: 'x',
      createdAt: '2026-11-13T10:30:00.000Z',
      updatedAt: '2026-11-13T10:30:00.000Z',
    });
  });

  it('never exposes the owner, chapter key or deletion marker', () => {
    const note = toPublicNote({
      ...minimalRecord,
      chapter: 'One',
      chapterKey: 'one',
      deletedAt: timestamp,
    });

    for (const internal of ['ownerId', 'chapterKey', 'deletedAt', '_id', '__v']) {
      expect(note).not.toHaveProperty(internal);
    }
    expect(note.chapter).toBe('One');
  });
});

describe('note endpoints without authentication', () => {
  it.each([
    ['POST', `/api/v1/books/${SOME_ID}/notes`],
    ['GET', `/api/v1/books/${SOME_ID}/notes`],
    ['GET', '/api/v1/notes'],
    ['GET', `/api/v1/notes/${SOME_ID}`],
    ['PATCH', `/api/v1/notes/${SOME_ID}`],
    ['DELETE', `/api/v1/notes/${SOME_ID}`],
  ])('%s %s returns 401 UNAUTHENTICATED without caching', async (method, path) => {
    const res = await request(createTestApp())[method.toLowerCase() as 'get'](path).send({});

    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toBe('Bearer');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it.each([
    ['a malformed body', '{"content": ', 400],
    ['an oversized body', JSON.stringify({ content: 'x'.repeat(110_000) }), 413],
  ])('sends no-store when the body parser rejects %s', async (_label, body, status) => {
    const res = await request(createTestApp())
      .patch(`/api/v1/notes/${SOME_ID}`)
      .set('Content-Type', 'application/json')
      .send(body);

    expect(res.status).toBe(status);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('sends no-store on note preflight requests', async () => {
    const res = await request(createTestApp())
      .options('/api/v1/notes')
      .set('Origin', 'http://localhost:5173')
      .set('Access-Control-Request-Method', 'PATCH');

    expect(res.status).toBe(204);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('sends no-store for an unknown path under /notes', async () => {
    const res = await request(createTestApp()).get('/api/v1/notes/x/y');

    expect(res.status).toBe(404);
    expect(res.headers['cache-control']).toBe('no-store');
  });
});
