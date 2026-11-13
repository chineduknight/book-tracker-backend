import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { SessionModel } from '../../src/modules/auth/session.model.js';
import { createLogger } from '../../src/config/logger.js';
import { createLogCapture } from '../helpers.js';
import { bearer, createAuthTestApp } from './auth-fixtures.js';
import { addPhysicalBook, signInLibraryReader, startSession } from './library-fixtures.js';

function readingRequests(app: Parameters<typeof request>[0], bookId: string, sessionId: string) {
  return [
    () => request(app).post(`/api/v1/books/${bookId}/reading-sessions`).send({}),
    () => request(app).get(`/api/v1/books/${bookId}/reading-sessions`),
    () => request(app).get(`/api/v1/books/${bookId}/reading-overview`),
    () => request(app).get('/api/v1/reading-sessions'),
    () => request(app).get(`/api/v1/reading-sessions/${sessionId}`),
    () => request(app).patch(`/api/v1/reading-sessions/${sessionId}`).send({ rating: 1 }),
  ];
}

describe('reading endpoint authentication', () => {
  it.each([
    ['no token', undefined],
    ['an invalid token', 'Bearer aaa.bbb.ccc'],
  ])('rejects all six endpoints with %s', async (_label, authorization) => {
    const app = createAuthTestApp();
    const reader = await signInLibraryReader(app);
    const book = await addPhysicalBook(reader);
    const session = await startSession(reader, book.id);

    for (const send of readingRequests(app, book.id, session.id)) {
      const pending = send();
      const res = await (authorization === undefined
        ? pending
        : pending.set('Authorization', authorization));
      expect(res.status).toBe(401);
      expect(res.headers['www-authenticate']).toBe('Bearer');
      expect(res.body.error.code).toBe('UNAUTHENTICATED');
    }
  });

  it('rejects all six endpoints once the session is revoked', async () => {
    const app = createAuthTestApp();
    const reader = await signInLibraryReader(app);
    const book = await addPhysicalBook(reader);
    const session = await startSession(reader, book.id);
    await SessionModel.updateMany(
      {},
      { $set: { revokedAt: new Date(), revocationReason: 'logout' } },
    );

    for (const send of readingRequests(app, book.id, session.id)) {
      const res = await send().set('Authorization', bearer(reader.tokens.accessToken));
      expect(res.status).toBe(401);
    }
  });
});

describe('reading logging', () => {
  it('never writes summaries, ratings, dates, progress or filters to the logs', async () => {
    const logs = createLogCapture();
    const reader = await signInLibraryReader(
      createAuthTestApp({ logger: createLogger('trace', logs.stream) }),
    );
    const book = await addPhysicalBook(reader);
    const session = await startSession(reader, book.id, {
      startedOn: '1987-03-14',
      progress: { unit: 'pages', value: 4321 },
    });
    await reader.reading.update(session.id, {
      status: 'completed',
      completedOn: '1987-04-15',
      rating: 5,
      summary: 'Private reflection about grief',
    });
    await reader.reading.update(session.id, { completedOn: '1980-01-01' });
    await reader.reading.listAll({ status: 'completed', sort: 'oldest' });

    const output = logs.output();
    expect(output).toContain('"path":"/api/v1/reading-sessions"');
    for (const privateText of [
      '1987-03-14',
      '1987-04-15',
      '1980-01-01',
      '"progress"',
      'Private reflection',
      '"rating"',
      'status=completed',
      'sort=oldest',
      reader.tokens.accessToken,
    ]) {
      expect(output).not.toContain(privateText);
    }
  });
});
