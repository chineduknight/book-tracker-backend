import type { Express } from 'express';
import mongoose from 'mongoose';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import {
  methodOf,
  parametersOf,
  pathOf,
  PRIVATE_ROUTES,
  type RouteKey,
} from '../route-inventory.js';
import { bearer, createAuthTestApp, registerReader } from './auth-fixtures.js';
import { addRichLibrary } from './export-fixtures.js';
import {
  addCopy,
  addGroup,
  addLocation,
  addNote,
  addPhysicalBook,
  addWish,
  signInLibraryReader,
  startSession,
  type LibraryReader,
} from './library-fixtures.js';
import { serializedRecordsOf } from './owner-records.js';

/** One id of each owner-scoped kind, named like the route parameters that carry them. */
interface LibraryIds {
  bookId: string;
  locationId: string;
  copyId: string;
  sessionId: string;
  noteId: string;
  categoryId: string;
  collectionId: string;
  wishlistItemId: string;
  loanId: string;
}

interface ProbeRequest {
  path: string;
  query?: Record<string, string>;
  body?: object;
}

/**
 * One way of naming another reader's record. `send` builds the request from the target ids (the
 * victim's, or ids that exist nowhere) and the intruder's own ids for the parts that must be valid.
 */
interface OwnershipProbe {
  route: RouteKey;
  reference: string;
  notFound: string;
  send: (target: LibraryIds, own: LibraryIds) => ProbeRequest;
}

const LOAN = { borrowerName: 'Intruder', lentOn: '2026-11-14' };

function atPath(route: RouteKey, body?: object) {
  return (target: LibraryIds): ProbeRequest => ({
    path: pathOf(route, (parameter) => target[parameter as keyof LibraryIds]),
    ...(body !== undefined && { body }),
  });
}

function probe(route: RouteKey, notFound: string, body?: object): OwnershipProbe {
  return {
    route,
    reference: parametersOf(route).join(' and '),
    notFound,
    send: atPath(route, body),
  };
}

const OWNERSHIP_PROBES: OwnershipProbe[] = [
  probe('GET /api/v1/books/:bookId', 'Book not found'),
  probe('PATCH /api/v1/books/:bookId', 'Book not found', { title: 'Taken over' }),
  probe('DELETE /api/v1/books/:bookId', 'Book not found'),
  probe('GET /api/v1/books/:bookId/organization', 'Book not found'),
  probe('GET /api/v1/locations/:locationId', 'Location not found'),
  probe('PATCH /api/v1/locations/:locationId', 'Location not found', { name: 'Taken over' }),
  probe('POST /api/v1/books/:bookId/copies', 'Book not found', {}),
  {
    route: 'POST /api/v1/books/:bookId/copies',
    reference: 'locationId in the body',
    notFound: 'Location not found',
    send: (target, own) => ({
      path: `/api/v1/books/${own.bookId}/copies`,
      body: { locationId: target.locationId },
    }),
  },
  probe('GET /api/v1/books/:bookId/copies', 'Book not found'),
  {
    route: 'GET /api/v1/books/:bookId/copies',
    reference: 'locationId filter',
    notFound: 'Location not found',
    send: (target, own) => ({
      path: `/api/v1/books/${own.bookId}/copies`,
      query: { locationId: target.locationId },
    }),
  },
  probe('GET /api/v1/copies/:copyId', 'Copy not found'),
  probe('PATCH /api/v1/copies/:copyId', 'Copy not found', { label: 'Taken over' }),
  {
    route: 'PATCH /api/v1/copies/:copyId',
    reference: 'locationId in the body',
    notFound: 'Location not found',
    send: (target, own) => ({
      path: `/api/v1/copies/${own.copyId}`,
      body: { locationId: target.locationId },
    }),
  },
  probe('DELETE /api/v1/copies/:copyId', 'Copy not found'),
  probe('POST /api/v1/books/:bookId/reading-sessions', 'Book not found', {}),
  probe('GET /api/v1/books/:bookId/reading-sessions', 'Book not found'),
  probe('GET /api/v1/books/:bookId/reading-overview', 'Book not found'),
  probe('GET /api/v1/reading-sessions/:sessionId', 'Reading session not found'),
  probe('PATCH /api/v1/reading-sessions/:sessionId', 'Reading session not found', {
    summary: 'Taken over',
  }),
  probe('POST /api/v1/books/:bookId/notes', 'Book not found', { kind: 'note', content: 'Mine' }),
  {
    route: 'POST /api/v1/books/:bookId/notes',
    reference: 'readingSessionId in the body',
    notFound: 'Reading session not found',
    send: (target, own) => ({
      path: `/api/v1/books/${own.bookId}/notes`,
      body: { kind: 'note', content: 'Mine', readingSessionId: target.sessionId },
    }),
  },
  probe('GET /api/v1/books/:bookId/notes', 'Book not found'),
  {
    route: 'GET /api/v1/books/:bookId/notes',
    reference: 'readingSessionId filter',
    notFound: 'Reading session not found',
    send: (target, own) => ({
      path: `/api/v1/books/${own.bookId}/notes`,
      query: { readingSessionId: target.sessionId },
    }),
  },
  {
    route: 'GET /api/v1/notes',
    reference: 'bookId filter',
    notFound: 'Book not found',
    send: (target) => ({ path: '/api/v1/notes', query: { bookId: target.bookId } }),
  },
  {
    route: 'GET /api/v1/notes',
    reference: 'readingSessionId filter',
    notFound: 'Reading session not found',
    send: (target) => ({ path: '/api/v1/notes', query: { readingSessionId: target.sessionId } }),
  },
  probe('GET /api/v1/notes/:noteId', 'Note not found'),
  probe('PATCH /api/v1/notes/:noteId', 'Note not found', { content: 'Taken over' }),
  probe('DELETE /api/v1/notes/:noteId', 'Note not found'),
  ...(
    [
      ['categories', 'categoryId', 'Category not found'],
      ['collections', 'collectionId', 'Collection not found'],
    ] as const
  ).flatMap(([root, groupParameter, groupNotFound]): OwnershipProbe[] => [
    probe(`GET /api/v1/${root}/:${groupParameter}`, groupNotFound),
    probe(`PATCH /api/v1/${root}/:${groupParameter}`, groupNotFound, { name: 'Taken over' }),
    probe(`DELETE /api/v1/${root}/:${groupParameter}`, groupNotFound),
    probe(`GET /api/v1/${root}/:${groupParameter}/books`, groupNotFound),
    ...(['PUT', 'DELETE'] as const).flatMap((method): OwnershipProbe[] => [
      {
        route: `${method} /api/v1/${root}/:${groupParameter}/books/:bookId`,
        reference: `${groupParameter} with the reader’s own book`,
        notFound: groupNotFound,
        send: (target, own) => ({
          path: `/api/v1/${root}/${target[groupParameter]}/books/${own.bookId}`,
        }),
      },
      {
        route: `${method} /api/v1/${root}/:${groupParameter}/books/:bookId`,
        reference: `bookId in the reader’s own ${groupParameter.replace('Id', '')}`,
        notFound: 'Book not found',
        send: (target, own) => ({
          path: `/api/v1/${root}/${own[groupParameter]}/books/${target.bookId}`,
        }),
      },
    ]),
  ]),
  probe('GET /api/v1/wishlist/:wishlistItemId', 'Wishlist item not found'),
  probe('PATCH /api/v1/wishlist/:wishlistItemId', 'Wishlist item not found', {
    title: 'Taken over',
  }),
  probe('DELETE /api/v1/wishlist/:wishlistItemId', 'Wishlist item not found'),
  {
    route: 'PUT /api/v1/wishlist/:wishlistItemId/acquisition',
    reference: 'wishlistItemId with the reader’s own book',
    notFound: 'Wishlist item not found',
    send: (target, own) => ({
      path: `/api/v1/wishlist/${target.wishlistItemId}/acquisition`,
      body: { bookId: own.bookId },
    }),
  },
  {
    route: 'PUT /api/v1/wishlist/:wishlistItemId/acquisition',
    reference: 'bookId in the body',
    notFound: 'Book not found',
    send: (target, own) => ({
      path: `/api/v1/wishlist/${own.wishlistItemId}/acquisition`,
      body: { bookId: target.bookId },
    }),
  },
  probe('POST /api/v1/copies/:copyId/loans', 'Copy not found', LOAN),
  probe('GET /api/v1/copies/:copyId/loans', 'Copy not found'),
  probe('GET /api/v1/copies/:copyId/loan-overview', 'Copy not found'),
  probe('GET /api/v1/loans/:loanId', 'Loan not found'),
  probe('PATCH /api/v1/loans/:loanId', 'Loan not found', { note: 'Taken over' }),
  probe('PUT /api/v1/loans/:loanId/return', 'Loan not found', { returnedOn: '2026-11-14' }),
];

const ROUTES_WITH_IDS = PRIVATE_ROUTES.filter((route) => parametersOf(route).length > 0);

async function victimWithEveryKindOfRecord(app: Express) {
  const victim = await signInLibraryReader(app);
  const library = await addRichLibrary(victim);
  const ids: LibraryIds = {
    bookId: library.paper.id,
    locationId: library.shelf.id,
    copyId: library.hardback.id,
    sessionId: library.reread.id,
    noteId: library.note.id,
    categoryId: library.category.id,
    collectionId: library.collection.id,
    wishlistItemId: library.wanted.id,
    loanId: library.activeLoan.id,
  };
  return { victim, ids };
}

async function intruderWithOwnRecords(app: Express) {
  const intruder = await signInLibraryReader(app);
  const book = await addPhysicalBook(intruder, 'Intruder book');
  const copy = await addCopy(intruder, book.id);
  const session = await startSession(intruder, book.id);
  const ids: LibraryIds = {
    bookId: book.id,
    locationId: (await addLocation(intruder, 'Intruder shelf')).id,
    copyId: copy.id,
    sessionId: session.id,
    noteId: (await addNote(intruder, book.id)).id,
    categoryId: (await addGroup(intruder.categories, 'Intruder category')).id,
    collectionId: (await addGroup(intruder.collections, 'Intruder collection')).id,
    wishlistItemId: (await addWish(intruder)).id,
    loanId: new mongoose.Types.ObjectId().toHexString(),
  };
  return { intruder, ids };
}

function idsThatExistNowhere(): LibraryIds {
  const freshId = () => new mongoose.Types.ObjectId().toHexString();
  return {
    bookId: freshId(),
    locationId: freshId(),
    copyId: freshId(),
    sessionId: freshId(),
    noteId: freshId(),
    categoryId: freshId(),
    collectionId: freshId(),
    wishlistItemId: freshId(),
    loanId: freshId(),
  };
}

function sendAs(app: Express, reader: LibraryReader, route: RouteKey, probeRequest: ProbeRequest) {
  const method = methodOf(route).toLowerCase() as 'get' | 'post' | 'put' | 'patch' | 'delete';
  const pending = request(app)
    [method](probeRequest.path)
    .set('Authorization', bearer(reader.tokens.accessToken))
    .query(probeRequest.query ?? {});
  return probeRequest.body === undefined ? pending : pending.send(probeRequest.body);
}

function errorWithoutRequestId(res: request.Response) {
  const { requestId, ...error } = (res.body as { error: { requestId: string } }).error;
  expect(requestId).toBe(res.headers['x-request-id']);
  return error;
}

describe('cross-owner isolation matrix', () => {
  it('probes every private route that takes an id', () => {
    const probedRoutes = new Set(OWNERSHIP_PROBES.map(({ route }) => route));

    expect(ROUTES_WITH_IDS.filter((route) => !probedRoutes.has(route))).toEqual([]);
    expect([...probedRoutes].filter((route) => !PRIVATE_ROUTES.includes(route))).toEqual([]);
  });

  it.each(OWNERSHIP_PROBES)(
    '$route answers a foreign $reference exactly like a missing one and changes nothing',
    async ({ route, notFound, send }) => {
      const app = createAuthTestApp();
      const { victim, ids: victimIds } = await victimWithEveryKindOfRecord(app);
      const { intruder, ids: ownIds } = await intruderWithOwnRecords(app);
      const victimBefore = await serializedRecordsOf(victim.userId);
      const intruderBefore = await serializedRecordsOf(intruder.userId);

      const foreign = await sendAs(app, intruder, route, send(victimIds, ownIds));
      const missing = await sendAs(app, intruder, route, send(idsThatExistNowhere(), ownIds));

      expect(foreign.status).toBe(404);
      expect(missing.status).toBe(404);
      expect(errorWithoutRequestId(foreign)).toEqual({ code: 'NOT_FOUND', message: notFound });
      expect(errorWithoutRequestId(missing)).toEqual(errorWithoutRequestId(foreign));
      expect(foreign.headers['cache-control']).toBe('no-store');
      expect(foreign.headers.location).toBeUndefined();
      expect(await serializedRecordsOf(victim.userId)).toBe(victimBefore);
      expect(await serializedRecordsOf(intruder.userId)).toBe(intruderBefore);
    },
  );
});

/** A request body the route accepts, so that only the malformed id can be refused. */
function validBodyFor(route: RouteKey): object | undefined {
  const nowhere = idsThatExistNowhere();
  return OWNERSHIP_PROBES.find((ownershipProbe) => ownershipProbe.route === route)?.send(
    nowhere,
    nowhere,
  ).body;
}

function invalidFieldsOf(res: request.Response): string[] {
  const { details } = (res.body as { error: { details: { field: string }[] } }).error;
  return details.map(({ field }) => field);
}

describe('malformed ids', () => {
  it.each(ROUTES_WITH_IDS)(
    '%s rejects a malformed id with 400 before any lookup',
    async (route) => {
      const app = createAuthTestApp();
      const reader = await signInLibraryReader(app);
      const body = validBodyFor(route);

      const res = await sendAs(app, reader, route, {
        path: pathOf(route, () => 'not-an-id'),
        ...(body !== undefined && { body }),
      });

      expect(res.status).toBe(400);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(invalidFieldsOf(res)).toEqual(parametersOf(route));
    },
  );
});

describe('revoked sessions', () => {
  it.each(PRIVATE_ROUTES)(
    '%s refuses an access token whose session was logged out',
    async (route) => {
      const app = createAuthTestApp();
      const { tokens } = await registerReader(app);
      const logout = await request(app)
        .post('/api/v1/auth/logout')
        .send({ refreshToken: tokens.refreshToken });
      expect(logout.status).toBe(204);
      const method = methodOf(route).toLowerCase() as 'get' | 'post' | 'put' | 'patch' | 'delete';

      const res = await request(app)
        [method](pathOf(route, () => new mongoose.Types.ObjectId().toHexString()))
        .set('Authorization', bearer(tokens.accessToken))
        .send({});

      expect(res.status).toBe(401);
      expect(res.headers['www-authenticate']).toBe('Bearer');
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body.error.code).toBe('UNAUTHENTICATED');
    },
  );
});
