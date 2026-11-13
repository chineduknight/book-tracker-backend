import request from 'supertest';
import { describe, expect, it } from 'vitest';
import {
  problemsWithProgress,
  problemsWithReadingDates,
} from '../src/modules/reading/reading.rules.js';
import {
  readingHistoryQuerySchema,
  startReadingSessionRequestSchema,
  updateReadingSessionRequestSchema,
} from '../src/modules/reading/reading.schema.js';
import { isExistingCalendarDate } from '../src/shared/calendar-date.js';
import { createTestApp } from './helpers.js';

const SOME_ID = '64b7f0c2a1b2c3d4e5f60718';

describe('calendar dates', () => {
  it.each([
    ['2024-02-29', true],
    ['2000-02-29', true],
    ['1900-02-29', false],
    ['2026-02-29', false],
    ['2026-02-30', false],
    ['2026-04-31', false],
    ['2026-13-01', false],
    ['2026-00-10', false],
    ['0001-01-01', true],
    ['0050-06-15', true],
    ['0000-01-01', false],
    ['2026-1-01', false],
    ['2026-01-01T00:00:00Z', false],
    ['01/02/2026', false],
  ])('%s is valid: %s', (date, valid) => {
    expect(isExistingCalendarDate(date)).toBe(valid);
  });
});

describe('startReadingSessionRequestSchema', () => {
  it('accepts an empty or missing body', () => {
    expect(startReadingSessionRequestSchema.parse({})).toEqual({});
    expect(startReadingSessionRequestSchema.parse(undefined)).toEqual({});
  });

  it('keeps dates exactly as entered', () => {
    expect(
      startReadingSessionRequestSchema.parse({
        status: 'completed',
        startedOn: '2019-12-31',
        completedOn: '2020-01-01',
        rating: 5,
        summary: '  Loved it. ',
      }),
    ).toEqual({
      status: 'completed',
      startedOn: '2019-12-31',
      completedOn: '2020-01-01',
      rating: 5,
      summary: 'Loved it.',
    });
  });

  it.each([
    [{ unit: 'pages', value: 0 }],
    [{ unit: 'pages', value: 100_000 }],
    [{ unit: 'chapters', value: 10_000 }],
    [{ unit: 'percent', value: 100 }],
  ])('accepts progress %j', (progress) => {
    expect(startReadingSessionRequestSchema.safeParse({ progress }).success).toBe(true);
  });

  it.each<[string, unknown]>([
    ['negative pages', { unit: 'pages', value: -1 }],
    ['too many pages', { unit: 'pages', value: 100_001 }],
    ['too many chapters', { unit: 'chapters', value: 10_001 }],
    ['over 100 percent', { unit: 'percent', value: 101 }],
    ['fractional percent', { unit: 'percent', value: 50.5 }],
    ['an unknown unit', { unit: 'words', value: 10 }],
    ['a value given as text', { unit: 'pages', value: '10' }],
    ['two metrics at once', { unit: 'pages', value: 10, chapters: 2 }],
    ['a missing value', { unit: 'pages' }],
    ['null on start', null],
  ])('rejects progress with %s', (_label, progress) => {
    expect(startReadingSessionRequestSchema.safeParse({ progress }).success).toBe(false);
  });

  it.each<[string, object]>([
    ['an impossible date', { startedOn: '2026-02-30' }],
    ['a timestamp', { completedOn: '2026-01-01T10:00:00Z' }],
    ['rating 0', { rating: 0 }],
    ['rating 6', { rating: 6 }],
    ['a fractional rating', { rating: 4.5 }],
    ['a blank summary', { summary: '  ' }],
    ['a summary over 5000 characters', { summary: 's'.repeat(5_001) }],
    ['an unknown status', { status: 'abandoned' }],
  ])('rejects %s', (_label, body) => {
    expect(startReadingSessionRequestSchema.safeParse(body).success).toBe(false);
  });

  it.each(['ownerId', 'userId', 'bookId', '_id', 'readingStatus', 'createdAt', 'revision'])(
    'rejects the field %s',
    (field) => {
      const result = startReadingSessionRequestSchema.safeParse({ [field]: 'x' });

      expect(result.error?.issues).toEqual([
        expect.objectContaining({ code: 'unrecognized_keys', keys: [field] }),
      ]);
    },
  );
});

describe('updateReadingSessionRequestSchema', () => {
  it('lets every optional field be cleared with null', () => {
    const changes = {
      progress: null,
      startedOn: null,
      completedOn: null,
      rating: null,
      summary: null,
    };

    expect(updateReadingSessionRequestSchema.parse(changes)).toEqual(changes);
  });

  it('rejects an empty change set, a null status and moving the session', () => {
    expect(updateReadingSessionRequestSchema.safeParse({}).success).toBe(false);
    expect(updateReadingSessionRequestSchema.safeParse({ status: null }).success).toBe(false);
    expect(updateReadingSessionRequestSchema.safeParse({ bookId: SOME_ID }).success).toBe(false);
  });
});

describe('reading date rules', () => {
  it('allows a completed session without any dates and an in-progress session with a start date', () => {
    expect(
      problemsWithReadingDates({
        status: 'completed',
        startedOn: undefined,
        completedOn: undefined,
      }),
    ).toEqual([]);
    expect(
      problemsWithReadingDates({
        status: 'in_progress',
        startedOn: '2026-01-01',
        completedOn: undefined,
      }),
    ).toEqual([]);
  });

  it('allows completion on the start day', () => {
    expect(
      problemsWithReadingDates({
        status: 'completed',
        startedOn: '2026-01-01',
        completedOn: '2026-01-01',
      }),
    ).toEqual([]);
  });

  it('rejects a completion date on an in-progress session', () => {
    expect(
      problemsWithReadingDates({
        status: 'in_progress',
        startedOn: undefined,
        completedOn: '2026-01-01',
      }),
    ).toEqual([
      { field: 'completedOn', message: 'can only be set on a completed reading session' },
    ]);
  });

  it('rejects completion before the start', () => {
    expect(
      problemsWithReadingDates({
        status: 'completed',
        startedOn: '2026-01-02',
        completedOn: '2026-01-01',
      }),
    ).toEqual([{ field: 'completedOn', message: 'must be on or after startedOn' }]);
  });
});

describe('reading progress rules', () => {
  it('allows progress up to the known counts and any progress when counts are unknown', () => {
    expect(problemsWithProgress({ unit: 'pages', value: 310 }, { pageCount: 310 })).toEqual([]);
    expect(problemsWithProgress({ unit: 'pages', value: 99_999 }, {})).toEqual([]);
    expect(problemsWithProgress({ unit: 'chapters', value: 19 }, { chapterCount: 19 })).toEqual([]);
    expect(problemsWithProgress({ unit: 'percent', value: 100 }, { pageCount: 10 })).toEqual([]);
  });

  it('rejects progress beyond the known page or chapter count', () => {
    expect(problemsWithProgress({ unit: 'pages', value: 311 }, { pageCount: 310 })).toEqual([
      { field: 'progress.value', message: "must not exceed the book's page count" },
    ]);
    expect(problemsWithProgress({ unit: 'chapters', value: 20 }, { chapterCount: 19 })).toEqual([
      { field: 'progress.value', message: "must not exceed the book's chapter count" },
    ]);
  });

  it('does not compare pages with the chapter count', () => {
    expect(problemsWithProgress({ unit: 'pages', value: 50 }, { chapterCount: 10 })).toEqual([]);
  });
});

describe('readingHistoryQuerySchema', () => {
  it('applies defaults and parses filters', () => {
    expect(readingHistoryQuerySchema.parse({})).toEqual({ page: 1, limit: 20, sort: 'recent' });
    expect(readingHistoryQuerySchema.parse({ status: 'completed', sort: 'oldest' })).toMatchObject({
      status: 'completed',
      sort: 'oldest',
    });
  });

  it.each<[string, Record<string, unknown>]>([
    ['an unknown status', { status: 'reading' }],
    ['a repeated status', { status: ['completed', 'in_progress'] }],
    ['an unknown sort', { sort: 'title' }],
    ['an unknown parameter', { bookId: SOME_ID }],
    ['limit 101', { limit: '101' }],
  ])('rejects %s', (_label, query) => {
    expect(readingHistoryQuerySchema.safeParse(query).success).toBe(false);
  });
});

describe('reading endpoints without authentication', () => {
  it.each([
    ['POST', `/api/v1/books/${SOME_ID}/reading-sessions`],
    ['GET', `/api/v1/books/${SOME_ID}/reading-sessions`],
    ['GET', `/api/v1/books/${SOME_ID}/reading-overview`],
    ['GET', '/api/v1/reading-sessions'],
    ['GET', `/api/v1/reading-sessions/${SOME_ID}`],
    ['PATCH', `/api/v1/reading-sessions/${SOME_ID}`],
  ])('%s %s returns 401 UNAUTHENTICATED without caching', async (method, path) => {
    const res = await request(createTestApp())[method.toLowerCase() as 'get'](path).send({});

    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toBe('Bearer');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('sends no-store when the body parser rejects a reading request', async () => {
    const res = await request(createTestApp())
      .patch(`/api/v1/reading-sessions/${SOME_ID}`)
      .set('Content-Type', 'application/json')
      .send('{"summary": ');

    expect(res.status).toBe(400);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('sends no-store on reading preflight requests', async () => {
    const res = await request(createTestApp())
      .options('/api/v1/reading-sessions')
      .set('Origin', 'http://localhost:5173')
      .set('Access-Control-Request-Method', 'GET');

    expect(res.status).toBe(204);
    expect(res.headers['cache-control']).toBe('no-store');
  });
});
