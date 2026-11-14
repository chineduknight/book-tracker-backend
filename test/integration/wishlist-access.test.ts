import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createLogger } from '../../src/config/logger.js';
import { SessionModel } from '../../src/modules/auth/session.model.js';
import { WishlistItemModel } from '../../src/modules/wishlist/wishlist.model.js';
import { createLogCapture } from '../helpers.js';
import { bearer, createAuthTestApp } from './auth-fixtures.js';
import {
  addGroup,
  addPhysicalBook,
  addWish,
  expectNotFound,
  signInLibraryReader,
  wishesFrom,
} from './library-fixtures.js';

function wishlistRequests(app: Parameters<typeof request>[0], itemId: string, bookId: string) {
  return [
    () => request(app).post('/api/v1/wishlist').send({ title: 'x' }),
    () => request(app).get('/api/v1/wishlist'),
    () => request(app).get(`/api/v1/wishlist/${itemId}`),
    () => request(app).patch(`/api/v1/wishlist/${itemId}`).send({ title: 'x' }),
    () => request(app).put(`/api/v1/wishlist/${itemId}/acquisition`).send({ bookId }),
    () => request(app).delete(`/api/v1/wishlist/${itemId}`),
  ];
}

describe('wishlist endpoint authentication', () => {
  it.each([
    ['no token', undefined],
    ['an invalid token', 'Bearer aaa.bbb.ccc'],
  ])('rejects all six endpoints with %s', async (_label, authorization) => {
    const app = createAuthTestApp();
    const reader = await signInLibraryReader(app);
    const wish = await addWish(reader);
    const book = await addPhysicalBook(reader);

    for (const send of wishlistRequests(app, wish.id, book.id)) {
      const pending = send();
      const res = await (authorization === undefined
        ? pending
        : pending.set('Authorization', authorization));
      expect(res.status).toBe(401);
      expect(res.headers['www-authenticate']).toBe('Bearer');
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body.error.code).toBe('UNAUTHENTICATED');
    }
    expect(await WishlistItemModel.findById(wish.id).orFail().lean()).toMatchObject({
      status: 'wanted',
      deletedAt: null,
    });
  });

  it('rejects all six endpoints once the session is revoked', async () => {
    const app = createAuthTestApp();
    const reader = await signInLibraryReader(app);
    const wish = await addWish(reader);
    const book = await addPhysicalBook(reader);
    await SessionModel.updateMany(
      {},
      { $set: { revokedAt: new Date(), revocationReason: 'logout' } },
    );

    for (const send of wishlistRequests(app, wish.id, book.id)) {
      const res = await send().set('Authorization', bearer(reader.tokens.accessToken));
      expect(res.status).toBe(401);
      expect(res.headers['cache-control']).toBe('no-store');
    }
  });
});

describe('wishlist ownership', () => {
  it('lets two readers hold the same wish without seeing or changing each other’s', async () => {
    const app = createAuthTestApp();
    const reader = await signInLibraryReader(app);
    const otherReader = await signInLibraryReader(app);
    const sameWish = { title: 'Dune', isbn: '9780441013593', note: 'shared words' };
    const mine = await addWish(reader, sameWish);
    const theirs = await addWish(otherReader, sameWish);
    const theirBook = await addPhysicalBook(otherReader, 'Dune');

    expectNotFound(await reader.wishlist.get(theirs.id), 'Wishlist item not found');
    expectNotFound(
      await reader.wishlist.update(theirs.id, { title: 'Hijacked' }),
      'Wishlist item not found',
    );
    expectNotFound(await reader.wishlist.remove(theirs.id), 'Wishlist item not found');
    expectNotFound(
      await reader.wishlist.acquire(theirs.id, { bookId: theirBook.id }),
      'Book not found',
    );
    expectNotFound(
      await reader.wishlist.acquire(mine.id, { bookId: theirBook.id }),
      'Book not found',
    );
    for (const query of [{}, { q: 'shared' }, { status: 'all' }]) {
      expect(wishesFrom(await reader.wishlist.list(query)).map((item) => item.id)).toEqual([
        mine.id,
      ]);
    }
    expect((await otherReader.wishlist.get(theirs.id)).body.data).toEqual(theirs);
  });

  it('hides a planted item whose owner differs from the reader', async () => {
    const app = createAuthTestApp();
    const reader = await signInLibraryReader(app);
    const otherReader = await signInLibraryReader(app);
    const planted = await WishlistItemModel.create({
      ownerId: otherReader.userId,
      title: 'planted wish',
      normalizedTitle: 'planted wish',
      priorityRank: 1,
    });
    const plantedId = planted._id.toHexString();
    const book = await addPhysicalBook(reader);

    expectNotFound(await reader.wishlist.get(plantedId), 'Wishlist item not found');
    expectNotFound(
      await reader.wishlist.update(plantedId, { title: 'x' }),
      'Wishlist item not found',
    );
    expectNotFound(
      await reader.wishlist.acquire(plantedId, { bookId: book.id }),
      'Wishlist item not found',
    );
    expectNotFound(await reader.wishlist.remove(plantedId), 'Wishlist item not found');
    expect((await reader.wishlist.list({ status: 'all', q: 'planted' })).body.data).toEqual([]);
    expect(await WishlistItemModel.findById(planted._id).orFail().lean()).toMatchObject({
      status: 'wanted',
      deletedAt: null,
    });
  });

  it('keeps wishes out of the catalogue, its search, its duplicate check and the groups', async () => {
    const reader = await signInLibraryReader(createAuthTestApp());
    await addWish(reader, { title: 'Wished Only', isbn: '9780441013593', authors: ['Herbert'] });
    const category = await addGroup(reader.categories, 'Science Fiction');

    expect((await reader.books.list()).body.data).toEqual([]);
    expect((await reader.books.list({ q: 'wished' })).body.data).toEqual([]);
    expect(
      (await reader.books.duplicateCheck({ title: 'Wished Only', isbn: '9780441013593' })).body.data
        .matches,
    ).toEqual([]);
    expect((await reader.categories.listBooks(category.id)).body.data).toEqual([]);
    expect((await reader.reading.listAll()).body.data).toEqual([]);
  });
});

describe('wishlist logging', () => {
  it('never writes titles, authors, notes, URLs or search strings to the logs', async () => {
    const logs = createLogCapture();
    const reader = await signInLibraryReader(
      createAuthTestApp({ logger: createLogger('trace', logs.stream) }),
    );
    const wish = await addWish(reader, {
      title: 'Secret Wish Title',
      authors: ['Hidden Author'],
      note: 'Private purchase plan',
      sourceUrl: 'https://shop.example.test/secret-path',
      coverUrl: 'https://covers.example.test/secret-cover.jpg',
    });
    const book = await addPhysicalBook(reader, 'Secret Owned Title');
    await reader.wishlist.update(wish.id, { note: 'Edited private plan' });
    await reader.wishlist.acquire(wish.id, { bookId: book.id });
    await reader.wishlist.list({ q: 'secret wish', status: 'all', sort: 'priority' });
    await reader.wishlist.create({ title: 'Rejected '.repeat(40), sourceUrl: 'not-a-url-secret' });

    const output = logs.output();
    expect(output).toContain('"path":"/api/v1/wishlist"');
    expect(output).toContain(`"path":"/api/v1/wishlist/${wish.id}/acquisition"`);
    for (const privateText of [
      'Secret Wish',
      'Hidden Author',
      'Private purchase',
      'Edited private',
      'secret-path',
      'secret-cover',
      'shop.example.test',
      'Secret Owned',
      'q=',
      'status=',
      'sort=',
      'Rejected',
      'not-a-url',
      '"title"',
      '"bookId"',
      reader.tokens.accessToken,
    ]) {
      expect(output).not.toContain(privateText);
    }
  });
});
