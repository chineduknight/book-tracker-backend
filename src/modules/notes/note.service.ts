import mongoose from 'mongoose';
import { toPaginationMeta, type PaginationMeta } from '../../shared/api-response.js';
import { AppError } from '../../shared/errors.js';
import { invalidFieldsError } from '../../shared/request-validation.js';
import { toTextSearchWords } from '../../shared/text.js';
import {
  isActiveBookOwnedByUser,
  keepDocumentsOfActiveBooks,
  requireActiveBookOwnedByUser,
} from '../books/book.service.js';
import { requireBookIdOfVisibleReadingSession } from '../reading/reading.service.js';
import { toPublicNote, type NoteDto } from './note.dto.js';
import { NoteModel, type NoteRecord } from './note.model.js';
import { problemsWithContentLength, toChapterKey } from './note.rules.js';
import type {
  AllNotesQuery,
  BookNotesQuery,
  NewNote,
  NoteChanges,
  NoteKind,
} from './note.schema.js';

const NOTE_ORDERS = {
  recent: { createdAt: -1, _id: -1 },
  oldest: { createdAt: 1, _id: 1 },
} as const;

type NoteFilters = Pick<BookNotesQuery, 'kind' | 'q' | 'chapter' | 'readingSessionId'>;

export interface NotePage {
  notes: NoteDto[];
  pagination: PaginationMeta;
}

function noteNotFoundError(): AppError {
  return new AppError(404, 'NOT_FOUND', 'Note not found');
}

function readingSessionBookMismatchError(): AppError {
  return new AppError(
    409,
    'READING_SESSION_BOOK_MISMATCH',
    'The reading session belongs to a different book',
  );
}

function toObjectId(id: string): mongoose.Types.ObjectId {
  return new mongoose.Types.ObjectId(id);
}

function isSameId(firstId: string, secondId: string): boolean {
  return firstId.toLowerCase() === secondId.toLowerCase();
}

function activeNotesOwnedBy(ownerId: string) {
  return { ownerId: toObjectId(ownerId), deletedAt: null };
}

function activeNoteOwnedBy(ownerId: string, noteId: string) {
  return { ...activeNotesOwnedBy(ownerId), _id: toObjectId(noteId) };
}

function toNoteFilter({ kind, q, chapter, readingSessionId }: NoteFilters) {
  return {
    ...(kind !== undefined && { kind }),
    ...(chapter !== undefined && { chapterKey: toChapterKey(chapter) }),
    ...(readingSessionId !== undefined && { readingSessionId: toObjectId(readingSessionId) }),
    ...(q !== undefined && { $text: { $search: toTextSearchWords(q) } }),
  };
}

function rejectContentTooLongForKind(note: NoteRecord, changes: NoteChanges): void {
  if (changes.content === undefined) return;
  const problems = problemsWithContentLength(note.kind, changes.content);
  if (problems.length > 0) throw invalidFieldsError(problems);
}

function toNoteUpdate(changes: NoteChanges) {
  const fieldsToSet: Record<string, unknown> = {};
  const fieldsToClear: Record<string, ''> = {};

  for (const [field, value] of Object.entries(changes)) {
    if (value === null) fieldsToClear[field] = '';
    else fieldsToSet[field] = value;
  }
  if (changes.chapter === null) fieldsToClear.chapterKey = '';
  if (typeof changes.chapter === 'string') fieldsToSet.chapterKey = toChapterKey(changes.chapter);

  return { $set: fieldsToSet, $unset: fieldsToClear };
}

/** A session link must point to a visible session of the owner and, if given, of this book. */
async function requireReadingSessionOfBook(
  ownerId: string,
  sessionId: string,
  bookId: string | undefined,
): Promise<void> {
  const sessionBookId = await requireBookIdOfVisibleReadingSession(ownerId, sessionId);
  if (bookId !== undefined && !isSameId(sessionBookId, bookId)) {
    throw readingSessionBookMismatchError();
  }
}

async function findVisibleNote(ownerId: string, noteId: string): Promise<NoteRecord> {
  const note = await NoteModel.findOne(activeNoteOwnedBy(ownerId, noteId)).lean();
  if (!note) throw noteNotFoundError();
  if (!(await isActiveBookOwnedByUser(ownerId, note.bookId.toHexString()))) {
    throw noteNotFoundError();
  }
  return note;
}

export async function createNote(
  ownerId: string,
  bookId: string,
  { readingSessionId = null, ...newNote }: NewNote,
): Promise<NoteDto> {
  await requireActiveBookOwnedByUser(ownerId, bookId);
  if (readingSessionId !== null) {
    await requireReadingSessionOfBook(ownerId, readingSessionId, bookId);
  }

  const note = await new NoteModel({
    ...newNote,
    ownerId,
    bookId,
    readingSessionId,
    ...(newNote.chapter !== undefined && { chapterKey: toChapterKey(newNote.chapter) }),
  }).save();
  return toPublicNote(note.toObject());
}

export async function listNotesOfBook(
  ownerId: string,
  bookId: string,
  { page, limit, sort, ...filters }: BookNotesQuery,
): Promise<NotePage> {
  await requireActiveBookOwnedByUser(ownerId, bookId);
  if (filters.readingSessionId !== undefined) {
    await requireReadingSessionOfBook(ownerId, filters.readingSessionId, bookId);
  }

  const filter = {
    ...activeNotesOwnedBy(ownerId),
    bookId: toObjectId(bookId),
    ...toNoteFilter(filters),
  };
  const [notes, total] = await Promise.all([
    NoteModel.find(filter)
      .sort(NOTE_ORDERS[sort])
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    NoteModel.countDocuments(filter),
  ]);

  return {
    notes: notes.map(toPublicNote),
    pagination: toPaginationMeta(page, limit, total),
  };
}

export async function listNotesOfOwner(
  ownerId: string,
  { page, limit, sort, bookId, ...filters }: AllNotesQuery,
): Promise<NotePage> {
  if (bookId !== undefined) await requireActiveBookOwnedByUser(ownerId, bookId);
  if (filters.readingSessionId !== undefined) {
    await requireReadingSessionOfBook(ownerId, filters.readingSessionId, bookId);
  }

  const [result] = await NoteModel.aggregate<{
    notes: NoteRecord[];
    total: { count: number }[];
  }>([
    {
      $match: {
        ...activeNotesOwnedBy(ownerId),
        ...(bookId !== undefined && { bookId: toObjectId(bookId) }),
        ...toNoteFilter(filters),
      },
    },
    { $sort: NOTE_ORDERS[sort] },
    ...keepDocumentsOfActiveBooks(ownerId, 'bookId'),
    {
      $facet: {
        notes: [{ $skip: (page - 1) * limit }, { $limit: limit }],
        total: [{ $count: 'count' }],
      },
    },
  ]);

  return {
    notes: (result?.notes ?? []).map(toPublicNote),
    pagination: toPaginationMeta(page, limit, result?.total[0]?.count ?? 0),
  };
}

export async function findNoteOwnedByUser(ownerId: string, noteId: string): Promise<NoteDto> {
  return toPublicNote(await findVisibleNote(ownerId, noteId));
}

/*
 * The visibility check and the write are separate operations, so the write repeats the owner and
 * not-deleted filter: a note deleted in between is reported as missing and never resurrected.
 */
export async function updateNoteOwnedByUser(
  ownerId: string,
  noteId: string,
  changes: NoteChanges,
): Promise<NoteDto> {
  const note = await findVisibleNote(ownerId, noteId);
  rejectContentTooLongForKind(note, changes);

  const updatedNote = await NoteModel.findOneAndUpdate(
    activeNoteOwnedBy(ownerId, noteId),
    toNoteUpdate(changes),
    { returnDocument: 'after', runValidators: true },
  ).lean();
  if (!updatedNote) throw noteNotFoundError();
  return toPublicNote(updatedNote);
}

export async function deleteNoteOwnedByUser(ownerId: string, noteId: string): Promise<void> {
  await findVisibleNote(ownerId, noteId);
  const { matchedCount } = await NoteModel.updateOne(activeNoteOwnedBy(ownerId, noteId), {
    $set: { deletedAt: new Date() },
  });
  if (matchedCount === 0) throw noteNotFoundError();
}

export interface NoteCounts {
  notes: number;
  highlights: number;
}

/** Non-deleted notes and highlights of the owner's active books. */
export async function countVisibleNotesByKind(ownerId: string): Promise<NoteCounts> {
  const counts = await NoteModel.aggregate<{ _id: NoteKind; count: number }>([
    { $match: activeNotesOwnedBy(ownerId) },
    { $group: { _id: { bookId: '$bookId', kind: '$kind' }, count: { $sum: 1 } } },
    ...keepDocumentsOfActiveBooks(ownerId, '_id.bookId'),
    { $group: { _id: '$_id.kind', count: { $sum: '$count' } } },
  ]);
  const countOf = (kind: NoteKind) => counts.find((row) => row._id === kind)?.count ?? 0;
  return { notes: countOf('note'), highlights: countOf('highlight') };
}

export interface RecentlyAddedNote {
  noteId: string;
  bookId: string;
  kind: NoteKind;
  createdAt: Date;
}

/** The newest notes of active books; hidden books are filtered out before the limit applies. */
export async function listRecentlyAddedNotes(
  ownerId: string,
  limit: number,
): Promise<RecentlyAddedNote[]> {
  const notes = await NoteModel.aggregate<{
    _id: mongoose.Types.ObjectId;
    bookId: mongoose.Types.ObjectId;
    kind: NoteKind;
    createdAt: Date;
  }>([
    { $match: activeNotesOwnedBy(ownerId) },
    { $sort: NOTE_ORDERS.recent },
    ...keepDocumentsOfActiveBooks(ownerId, 'bookId'),
    { $limit: limit },
    { $project: { bookId: 1, kind: 1, createdAt: 1 } },
  ]);
  return notes.map(({ _id, bookId, kind, createdAt }) => ({
    noteId: _id.toHexString(),
    bookId: bookId.toHexString(),
    kind,
    createdAt,
  }));
}
