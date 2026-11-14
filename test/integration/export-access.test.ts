import mongoose from 'mongoose';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { createLogger } from '../../src/config/logger.js';
import { RefreshTokenModel } from '../../src/modules/auth/refresh-token.model.js';
import { SessionModel } from '../../src/modules/auth/session.model.js';
import { BookModel } from '../../src/modules/books/book.model.js';
import { CategoryModel } from '../../src/modules/categories/category.model.js';
import { BookCollectionModel } from '../../src/modules/collections/collection.model.js';
import { PhysicalCopyModel } from '../../src/modules/copies/copy.model.js';
import { LoanModel } from '../../src/modules/loans/loan.model.js';
import { LocationModel } from '../../src/modules/locations/location.model.js';
import { NoteModel } from '../../src/modules/notes/note.model.js';
import { ReadingSessionModel } from '../../src/modules/reading/reading.model.js';
import { UserModel } from '../../src/modules/users/user.model.js';
import { WishlistItemModel } from '../../src/modules/wishlist/wishlist.model.js';
import { ARCHIVE_ORDER } from '../../src/shared/archive-order.js';
import { createLogCapture } from '../helpers.js';
import { bearer, createAuthTestApp } from './auth-fixtures.js';
import { addRichLibrary, archiveFrom } from './export-fixtures.js';
import {
  addCopy,
  addNote,
  addPhysicalBook,
  invalidFieldsOf,
  lendCopy,
  signInLibraryReader,
  startSession,
  type LibraryReader,
} from './library-fixtures.js';
import { winningIndexesOf, winningStagesOf } from './query-plans.js';

const EXPORT_FILES = ['archive', 'books.csv', 'reading-sessions.csv', 'loans.csv', 'notes.md'];
const ALL_MODELS = [
  UserModel,
  SessionModel,
  RefreshTokenModel,
  BookModel,
  LocationModel,
  PhysicalCopyModel,
  ReadingSessionModel,
  NoteModel,
  CategoryModel,
  BookCollectionModel,
  WishlistItemModel,
  LoanModel,
];
const SECTION_MODELS = {
  books: BookModel,
  locations: LocationModel,
  copies: PhysicalCopyModel,
  readingSessions: ReadingSessionModel,
  notes: NoteModel,
  categories: CategoryModel,
  collections: BookCollectionModel,
  wishlist: WishlistItemModel,
  loans: LoanModel,
} as const;
const FORBIDDEN_TEXT = [
  'passwordHash',
  'tokenHash',
  'accessToken',
  'refreshToken',
  'revision',
  'hasPhysicalCopyHistory',
  'normalizedTitle',
  'normalizedName',
  'normalizedIsbn',
  'priorityRank',
  'chapterKey',
  '__v',
  'ownerId',
  '"_id"',
  '$argon2',
];

async function downloadEverything(reader: LibraryReader) {
  return Promise.all([
    reader.exports.archive(),
    reader.exports.booksCsv(),
    reader.exports.readingSessionsCsv(),
    reader.exports.loansCsv(),
    reader.exports.notesMarkdown(),
  ]);
}

async function snapshotDatabase() {
  return Promise.all(ALL_MODELS.map((model) => model.collection.find().sort({ _id: 1 }).toArray()));
}

describe('export authentication and query strictness', () => {
  it.each([
    ['no token', undefined],
    ['an invalid token', 'Bearer aaa.bbb.ccc'],
  ])('rejects all five downloads with %s', async (_label, authorization) => {
    const app = createAuthTestApp();

    for (const file of EXPORT_FILES) {
      const pending = request(app).get(`/api/v1/export/${file}`);
      const res = await (authorization === undefined
        ? pending
        : pending.set('Authorization', authorization));
      expect(res.status).toBe(401);
      expect(res.headers['www-authenticate']).toBe('Bearer');
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['content-disposition']).toBeUndefined();
      expect(res.body.error.code).toBe('UNAUTHENTICATED');
    }
  });

  it('rejects all five downloads once the session is revoked', async () => {
    const app = createAuthTestApp();
    const reader = await signInLibraryReader(app);
    await SessionModel.updateMany(
      {},
      { $set: { revokedAt: new Date(), revocationReason: 'logout' } },
    );

    for (const file of EXPORT_FILES) {
      const res = await request(app)
        .get(`/api/v1/export/${file}`)
        .set('Authorization', bearer(reader.tokens.accessToken));
      expect(res.status).toBe(401);
    }
  });

  it('refuses the archive with 401 when the signed-in account no longer exists', async () => {
    const reader = await signInLibraryReader(createAuthTestApp());
    await UserModel.deleteMany({});

    const res = await reader.exports.archive();

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it.each(EXPORT_FILES)('rejects unknown and repeated query parameters on %s', async (file) => {
    const app = createAuthTestApp();
    const reader = await signInLibraryReader(app);
    const download = (query: string) =>
      request(app)
        .get(`/api/v1/export/${file}?${query}`)
        .set('Authorization', bearer(reader.tokens.accessToken));

    for (const [query, fields] of [
      ['format=xml', ['format']],
      ['since=2026-01-01&since=2026-02-01', ['since']],
      ['ownerId=x', ['ownerId']],
    ] as const) {
      const res = await download(query);
      expect(invalidFieldsOf(res)).toEqual(fields);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['content-type']).toBe('application/json; charset=utf-8');
      expect(res.headers['content-disposition']).toBeUndefined();
    }
  });
});

describe('export isolation and privacy', () => {
  afterEach(() => {
    mongoose.set('debug', false);
  });

  it('exports only the reader’s own records, never resolving planted foreign references', async () => {
    const app = createAuthTestApp();
    const jane = await signInLibraryReader(app);
    const omar = await signInLibraryReader(app);
    await addRichLibrary(jane);
    const omarsLibrary = await addRichLibrary(omar);
    const plantedNote = await NoteModel.create({
      ownerId: jane.userId,
      bookId: omarsLibrary.paper.id,
      kind: 'note',
      content: 'planted',
    });
    await LoanModel.create({
      ownerId: omar.userId,
      copyId: new mongoose.Types.ObjectId(),
      bookId: new mongoose.Types.ObjectId(),
      borrowerName: 'Omar Only Borrower',
      lentOn: '2026-01-01',
    });

    const janes = archiveFrom(await jane.exports.archive());
    const omars = archiveFrom(await omar.exports.archive());

    for (const [archive, owner] of [
      [janes, jane],
      [omars, omar],
    ] as const) {
      expect(archive.profile.id).toBe(owner.userId);
      for (const [section, model] of Object.entries(SECTION_MODELS)) {
        const stored = await model.collection.countDocuments({
          ownerId: new mongoose.Types.ObjectId(owner.userId),
        });
        const exported = archive[section as keyof typeof SECTION_MODELS].length;
        expect({ section, exported }).toEqual({ section, exported: stored });
      }
    }
    const janeIds = new Set(JSON.stringify(janes).match(/"id":"[0-9a-f]{24}"/g));
    const omarIds = new Set(JSON.stringify(omars).match(/"id":"[0-9a-f]{24}"/g));
    expect([...janeIds].filter((id) => omarIds.has(id))).toEqual([]);
    expect(janes.notes.at(-1)).toMatchObject({
      id: plantedNote._id.toHexString(),
      bookId: omarsLibrary.paper.id,
    });
    expect(janes.books.map((book) => book.id)).not.toContain(omarsLibrary.paper.id);
    const janeFiles = (await downloadEverything(jane)).map((res) => res.text).join('\n');
    expect(janeFiles).not.toContain('Omar Only Borrower');
    expect(janeFiles).not.toContain(omar.userId);
  });

  it('never includes credentials, tokens or internal database fields in any download', async () => {
    const reader = await signInLibraryReader(createAuthTestApp());
    await addRichLibrary(reader);

    const operations: string[] = [];
    mongoose.set('debug', (collection: string, method: string) => {
      operations.push(`${collection}.${method}`);
    });
    const downloads = await downloadEverything(reader);
    mongoose.set('debug', false);

    for (const res of downloads) {
      expect(res.status).toBe(200);
      for (const text of FORBIDDEN_TEXT) expect(res.text).not.toContain(text);
      expect(res.text).not.toContain(reader.tokens.accessToken);
      expect(res.text).not.toContain(reader.tokens.refreshToken);
    }
    expect(Object.keys(archiveFrom(downloads[0]).profile).sort()).toEqual([
      'createdAt',
      'email',
      'id',
      'name',
    ]);
    expect(operations.filter((operation) => operation.startsWith('refreshtokens'))).toEqual([]);
    expect(operations.filter((operation) => operation.startsWith('sessions'))).toHaveLength(5);
  });

  it('never writes to any collection', async () => {
    const reader = await signInLibraryReader(createAuthTestApp());
    await addRichLibrary(reader);
    const before = await snapshotDatabase();

    for (const res of await downloadEverything(reader)) expect(res.status).toBe(200);

    expect(await snapshotDatabase()).toEqual(before);
  });

  it('issues the same number of queries whatever the size of the library', async () => {
    const queriesFor = async (bookCount: number) => {
      const reader = await signInLibraryReader(createAuthTestApp());
      for (let index = 0; index < bookCount; index += 1) {
        const book = await addPhysicalBook(reader, `Book ${index}`);
        await startSession(reader, book.id, { status: 'completed' });
        await addNote(reader, book.id);
        await lendCopy(reader, (await addCopy(reader, book.id)).id);
      }
      const operations: string[] = [];
      mongoose.set('debug', (collection: string, method: string) => {
        operations.push(`${collection}.${method}`);
      });
      for (const res of await downloadEverything(reader)) expect(res.status).toBe(200);
      mongoose.set('debug', false);
      return operations.sort();
    };

    expect(await queriesFor(12)).toEqual(await queriesFor(1));
  });

  it('reads every section through an owner-scoped index', async () => {
    const ownerId = new mongoose.Types.ObjectId();
    const owners = [ownerId, new mongoose.Types.ObjectId()];
    await BookModel.insertMany(
      owners.flatMap((ownerId) =>
        Array.from({ length: 20 }, (_, index) => ({
          ownerId,
          title: `B${index}`,
          normalizedTitle: `b${index}`,
          format: 'ebook',
          deletedAt: index % 3 === 0 ? new Date() : null,
        })),
      ),
    );
    for (const model of Object.values(SECTION_MODELS)) {
      const explanation = await model.collection
        .find({ ownerId })
        .sort(ARCHIVE_ORDER)
        .explain('queryPlanner');
      const indexes = winningIndexesOf(explanation);
      expect(indexes.length).toBeGreaterThan(0);
      for (const index of indexes) expect(index).toMatch(/^owner_/);
      expect(winningStagesOf(explanation)).not.toContain('COLLSCAN');
    }
  });
});

describe('export logging', () => {
  it('never writes titles, notes, borrowers, filenames or query strings to the logs', async () => {
    const logs = createLogCapture();
    const reader = await signInLibraryReader(
      createAuthTestApp({ logger: createLogger('trace', logs.stream) }),
    );
    await addRichLibrary(reader);
    await downloadEverything(reader);
    await reader.exports.booksCsv({ format: 'secret-format' });

    const output = logs.output();
    expect(output).toContain('"path":"/api/v1/export/books.csv"');
    for (const privateText of [
      'Society',
      'Thoughts',
      'Ada Okafor',
      '+234',
      'Litany',
      'book-tracker-books-',
      'attachment',
      'secret-format',
      'format=',
      reader.tokens.accessToken,
    ]) {
      expect(output).not.toContain(privateText);
    }
  });
});
