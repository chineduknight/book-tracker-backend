import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createLogger } from '../../src/config/logger.js';
import { SessionModel } from '../../src/modules/auth/session.model.js';
import { createLogCapture } from '../helpers.js';
import { bearer, createAuthTestApp } from './auth-fixtures.js';
import { addGroup, addPhysicalBook, signInLibraryReader } from './library-fixtures.js';

function groupRequests(app: Parameters<typeof request>[0], groupId: string, bookId: string) {
  return ['categories', 'collections']
    .flatMap((root) => [
      () => request(app).post(`/api/v1/${root}`).send({ name: 'x' }),
      () => request(app).get(`/api/v1/${root}`),
      () => request(app).get(`/api/v1/${root}/${groupId}`),
      () => request(app).patch(`/api/v1/${root}/${groupId}`).send({ name: 'x' }),
      () => request(app).delete(`/api/v1/${root}/${groupId}`),
      () => request(app).put(`/api/v1/${root}/${groupId}/books/${bookId}`),
      () => request(app).delete(`/api/v1/${root}/${groupId}/books/${bookId}`),
      () => request(app).get(`/api/v1/${root}/${groupId}/books`),
    ])
    .concat([
      () => request(app).get('/api/v1/categories/presets'),
      () => request(app).get(`/api/v1/books/${bookId}/organization`),
    ]);
}

describe('category and collection endpoint authentication', () => {
  it.each([
    ['no token', undefined],
    ['an invalid token', 'Bearer aaa.bbb.ccc'],
  ])('rejects every endpoint with %s', async (_label, authorization) => {
    const app = createAuthTestApp();
    const reader = await signInLibraryReader(app);
    const book = await addPhysicalBook(reader);
    const group = await addGroup(reader.categories, 'Fiction');

    const requests = groupRequests(app, group.id, book.id);
    expect(requests).toHaveLength(18);
    for (const send of requests) {
      const pending = send();
      const res = await (authorization === undefined
        ? pending
        : pending.set('Authorization', authorization));
      expect(res.status).toBe(401);
      expect(res.headers['www-authenticate']).toBe('Bearer');
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body.error.code).toBe('UNAUTHENTICATED');
    }
  });

  it('rejects every endpoint once the session is revoked', async () => {
    const app = createAuthTestApp();
    const reader = await signInLibraryReader(app);
    const book = await addPhysicalBook(reader);
    const group = await addGroup(reader.collections, 'Favourites');
    await SessionModel.updateMany(
      {},
      { $set: { revokedAt: new Date(), revocationReason: 'logout' } },
    );

    for (const send of groupRequests(app, group.id, book.id)) {
      const res = await send().set('Authorization', bearer(reader.tokens.accessToken));
      expect(res.status).toBe(401);
      expect(res.headers['cache-control']).toBe('no-store');
    }
  });
});

describe('category and collection logging', () => {
  it('never writes group names, descriptions, titles or query strings to the logs', async () => {
    const logs = createLogCapture();
    const reader = await signInLibraryReader(
      createAuthTestApp({ logger: createLogger('trace', logs.stream) }),
    );
    const book = await addPhysicalBook(reader, 'Secret Diary Title');
    const category = await addGroup(reader.categories, 'Hidden Interest', 'Private reason');
    await reader.categories.create({ name: 'hidden interest' });
    await reader.collections.create({ name: 'Books for Isioma', description: 'Gift ideas' });
    await reader.categories.update(category.id, { name: 'Renamed Interest' });
    await reader.categories.addBook(category.id, book.id);
    await reader.categories.listBooks(category.id, { limit: '5', page: '1' });
    await reader.categories.list({ limit: '7' });
    await reader.organizationOf(book.id);
    await reader.categories.update(category.id, { name: '' });

    const output = logs.output();
    expect(output).toContain('"path":"/api/v1/categories"');
    expect(output).toContain(`"path":"/api/v1/categories/${category.id}/books/${book.id}"`);
    for (const privateText of [
      'Secret Diary',
      'Hidden Interest',
      'hidden interest',
      'Private reason',
      'Isioma',
      'Gift ideas',
      'Renamed',
      'limit=',
      'page=',
      '"name"',
      reader.tokens.accessToken,
    ]) {
      expect(output).not.toContain(privateText);
    }
  });

  it('never echoes a clashing or invalid name in the error response', async () => {
    const reader = await signInLibraryReader(createAuthTestApp());
    await addGroup(reader.collections, 'Private Shelf Name');

    const clash = await reader.collections.create({ name: 'private shelf name' });
    const invalid = await reader.collections.create({ name: 'Private Shelf Name'.repeat(10) });

    expect(clash.status).toBe(409);
    expect(invalid.status).toBe(400);
    for (const res of [clash, invalid]) expect(res.text).not.toMatch(/private shelf/i);
  });
});
