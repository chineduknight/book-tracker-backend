import mongoose from 'mongoose';
import { beforeEach, describe, expect, it } from 'vitest';
import { NoteModel } from '../../src/modules/notes/note.model.js';
import { indexesUsedBy, indexNamesIn, stagesUsedBy } from './query-plans.js';

const ownerId = new mongoose.Types.ObjectId();
const bookId = new mongoose.Types.ObjectId();
const readingSessionId = new mongoose.Types.ObjectId();
const activeNotes = { ownerId, deletedAt: null };
const RECENT_FIRST = { createdAt: -1, _id: -1 } as const;

async function seedNotesOfSeveralReaders() {
  const owners = [ownerId, new mongoose.Types.ObjectId(), new mongoose.Types.ObjectId()];
  const books = [bookId, new mongoose.Types.ObjectId()];
  await NoteModel.insertMany(
    owners.flatMap((owner) =>
      books.flatMap((book, bookIndex) =>
        Array.from({ length: 20 }, (_, index) => ({
          ownerId: owner,
          bookId: book,
          readingSessionId: index % 4 === 0 ? readingSessionId : null,
          kind: index % 2 === 0 ? 'note' : 'highlight',
          content: `Dragon note ${bookIndex}.${index}`,
          chapter: `Chapter ${index % 3}`,
          chapterKey: `chapter ${index % 3}`,
          deletedAt: index % 5 === 0 ? new Date() : null,
        })),
      ),
    ),
  );
}

describe('note indexes', () => {
  beforeEach(seedNotesOfSeveralReaders);

  it('declares the planned owner-scoped indexes, none of them unique', async () => {
    const indexes = await NoteModel.collection.indexes();

    expect(indexes.map((index) => index.name).sort()).toEqual([
      '_id_',
      'owner_active_recent',
      'owner_active_text',
      'owner_book_active_recent',
      'owner_session_active_recent',
    ]);
    expect(indexes.filter((index) => index.unique)).toEqual([]);
    expect(indexes.find((index) => index.name === 'owner_active_text')).toMatchObject({
      key: { ownerId: 1, deletedAt: 1, _fts: 'text', _ftsx: 1 },
      weights: { title: 1, content: 1, commentary: 1, chapter: 1 },
      default_language: 'none',
    });
  });

  it.each([
    [
      'one book’s notes',
      () => NoteModel.find({ ...activeNotes, bookId }).sort(RECENT_FIRST),
      'owner_book_active_recent',
    ],
    [
      'one book’s notes in one chapter',
      () =>
        NoteModel.find({ ...activeNotes, bookId, chapterKey: 'chapter 1', kind: 'note' }).sort({
          createdAt: 1,
          _id: 1,
        }),
      'owner_book_active_recent',
    ],
    [
      'notes linked to one reading session',
      () => NoteModel.find({ ...activeNotes, readingSessionId }).sort(RECENT_FIRST),
      'owner_session_active_recent',
    ],
    [
      'all of a reader’s notes',
      () => NoteModel.find(activeNotes).sort(RECENT_FIRST),
      'owner_active_recent',
    ],
  ])(
    'serves %s from an owner-scoped index without sorting in memory',
    async (_label, buildQuery, index) => {
      expect(await indexesUsedBy(buildQuery())).toEqual([index]);
      expect(await stagesUsedBy(buildQuery())).not.toContain('SORT');
    },
  );

  it('starts the global aggregation from the owner-scoped recent index', async () => {
    const explanation = await NoteModel.aggregate([
      { $match: { ...activeNotes, kind: 'highlight' } },
      { $sort: RECENT_FIRST },
    ]).explain('queryPlanner');

    expect(indexNamesIn(explanation)).toContain('owner_active_recent');
  });

  it('serves text search from the compound text index scoped to the owner’s active notes', async () => {
    const search = () =>
      NoteModel.find({ ...activeNotes, bookId, $text: { $search: 'dragon' } }).sort(RECENT_FIRST);

    expect(await indexesUsedBy(search())).toEqual(['owner_active_text']);
    expect(await stagesUsedBy(search())).toContain('TEXT_MATCH');
    expect(await search().countDocuments()).toBe(16);
  });

  it.each([
    ['no owner or deletion filter', {}],
    ['an owner filter alone', { ownerId }],
    ['a deletion filter alone', { deletedAt: null }],
    ['a range instead of owner equality', { ownerId: { $in: [ownerId, bookId] }, deletedAt: null }],
  ])('refuses a text search with %s', async (_label, scope) => {
    await expect(NoteModel.find({ ...scope, $text: { $search: 'dragon' } })).rejects.toThrow(
      /text index/i,
    );
  });
});
