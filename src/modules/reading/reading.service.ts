import mongoose from 'mongoose';
import { isDuplicateKeyError } from '../../db/mongo.js';
import { toPaginationMeta, type PaginationMeta } from '../../shared/api-response.js';
import { AppError } from '../../shared/errors.js';
import { invalidFieldsError } from '../../shared/request-validation.js';
import {
  findLengthsOfActiveBook,
  keepDocumentsOfActiveBooks,
  requireActiveBookOwnedByUser,
  requireLengthsOfActiveBook,
  type BookLengths,
} from '../books/book.service.js';
import {
  toPublicReadingSession,
  type BookReadingOverviewDto,
  type BookReadingStatus,
  type ReadingSessionDto,
} from './reading.dto.js';
import { ReadingSessionModel, type ReadingSessionRecord } from './reading.model.js';
import {
  problemsWithProgress,
  problemsWithReadingDates,
  type ReadingSessionDates,
} from './reading.rules.js';
import type {
  NewReadingSession,
  ReadingHistoryQuery,
  ReadingProgress,
  ReadingSessionChanges,
} from './reading.schema.js';

const MAX_UPDATE_ATTEMPTS = 5;
const CLEARABLE_FIELDS = ['progress', 'startedOn', 'completedOn', 'rating', 'summary'] as const;
const HISTORY_ORDERS = {
  recent: { createdAt: -1, _id: -1 },
  oldest: { createdAt: 1, _id: 1 },
} as const;

export interface ReadingSessionPage {
  sessions: ReadingSessionDto[];
  pagination: PaginationMeta;
}

interface VisibleReadingSession {
  session: ReadingSessionRecord;
  bookLengths: BookLengths;
}

function readingSessionNotFoundError(): AppError {
  return new AppError(404, 'NOT_FOUND', 'Reading session not found');
}

function readingSessionInProgressError(): AppError {
  return new AppError(
    409,
    'READING_SESSION_IN_PROGRESS',
    'This book already has a reading session in progress',
  );
}

function invalidReadingTransitionError(): AppError {
  return new AppError(
    409,
    'INVALID_READING_TRANSITION',
    'A completed reading session cannot be reopened; start a new session to reread the book',
  );
}

function readingSessionUpdateConflictError(): AppError {
  return new AppError(
    409,
    'READING_SESSION_UPDATE_CONFLICT',
    'The reading session kept changing during the update; try again',
  );
}

function toObjectId(id: string): mongoose.Types.ObjectId {
  return new mongoose.Types.ObjectId(id);
}

function rejectInvalidSessionState(
  dates: ReadingSessionDates,
  newProgress: ReadingProgress | undefined,
  bookLengths: BookLengths,
): void {
  const problems = [
    ...problemsWithReadingDates(dates),
    ...(newProgress === undefined ? [] : problemsWithProgress(newProgress, bookLengths)),
  ];
  if (problems.length > 0) throw invalidFieldsError(problems);
}

function valueAfterChange<Value>(
  change: Value | null | undefined,
  current: Value | null | undefined,
): Value | undefined {
  if (change === undefined) return current ?? undefined;
  return change ?? undefined;
}

function toSessionUpdate(changes: ReadingSessionChanges) {
  const fieldsToSet: Record<string, unknown> = {};
  const fieldsToClear: Record<string, ''> = {};

  if (changes.status !== undefined) fieldsToSet.status = changes.status;
  for (const field of CLEARABLE_FIELDS) {
    const value = changes[field];
    if (value === null && field === 'progress') fieldsToSet.progress = null;
    else if (value === null) fieldsToClear[field] = '';
    else if (value !== undefined) fieldsToSet[field] = value;
  }

  return { $set: fieldsToSet, $unset: fieldsToClear, $inc: { revision: 1 } };
}

async function findVisibleSession(
  ownerId: string,
  sessionId: string,
): Promise<VisibleReadingSession> {
  const session = await ReadingSessionModel.findOne({ _id: sessionId, ownerId }).lean();
  if (!session) throw readingSessionNotFoundError();
  const bookLengths = await findLengthsOfActiveBook(ownerId, session.bookId.toHexString());
  if (!bookLengths) throw readingSessionNotFoundError();
  return { session, bookLengths };
}

function readingStatusOf(hasActiveSession: boolean, completedSessions: number): BookReadingStatus {
  if (hasActiveSession) return 'reading';
  if (completedSessions > 0) return 'completed';
  return 'unread';
}

export async function startReadingSession(
  ownerId: string,
  bookId: string,
  newSession: NewReadingSession,
): Promise<ReadingSessionDto> {
  const bookLengths = await requireLengthsOfActiveBook(ownerId, bookId);
  const status = newSession.status ?? 'in_progress';
  rejectInvalidSessionState(
    { status, startedOn: newSession.startedOn, completedOn: newSession.completedOn },
    newSession.progress,
    bookLengths,
  );

  try {
    const session = await new ReadingSessionModel({
      ...newSession,
      ownerId,
      bookId,
      status,
    }).save();
    return toPublicReadingSession(session.toObject());
  } catch (error) {
    if (isDuplicateKeyError(error)) throw readingSessionInProgressError();
    throw error;
  }
}

export async function listReadingSessionsOfBook(
  ownerId: string,
  bookId: string,
  { page, limit, status, sort }: ReadingHistoryQuery,
): Promise<ReadingSessionPage> {
  await requireActiveBookOwnedByUser(ownerId, bookId);

  const filter = { ownerId, bookId, ...(status !== undefined && { status }) };
  const [sessions, total] = await Promise.all([
    ReadingSessionModel.find(filter)
      .sort(HISTORY_ORDERS[sort])
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    ReadingSessionModel.countDocuments(filter),
  ]);

  return {
    sessions: sessions.map(toPublicReadingSession),
    pagination: toPaginationMeta(page, limit, total),
  };
}

export async function listReadingSessionsOfOwner(
  ownerId: string,
  { page, limit, status, sort }: ReadingHistoryQuery,
): Promise<ReadingSessionPage> {
  const [result] = await ReadingSessionModel.aggregate<{
    sessions: ReadingSessionRecord[];
    total: { count: number }[];
  }>([
    { $match: { ownerId: toObjectId(ownerId), ...(status !== undefined && { status }) } },
    { $sort: HISTORY_ORDERS[sort] },
    ...keepDocumentsOfActiveBooks(ownerId, 'bookId'),
    {
      $facet: {
        sessions: [{ $skip: (page - 1) * limit }, { $limit: limit }],
        total: [{ $count: 'count' }],
      },
    },
  ]);

  return {
    sessions: (result?.sessions ?? []).map(toPublicReadingSession),
    pagination: toPaginationMeta(page, limit, result?.total[0]?.count ?? 0),
  };
}

export async function findReadingOverview(
  ownerId: string,
  bookId: string,
): Promise<BookReadingOverviewDto> {
  await requireActiveBookOwnedByUser(ownerId, bookId);

  const [result] = await ReadingSessionModel.aggregate<{
    totals: { total: number; completed: number }[];
    active: ReadingSessionRecord[];
    lastCompleted: ReadingSessionRecord[];
  }>([
    { $match: { ownerId: toObjectId(ownerId), bookId: toObjectId(bookId) } },
    { $sort: HISTORY_ORDERS.recent },
    {
      $facet: {
        totals: [
          {
            $group: {
              _id: null,
              total: { $sum: 1 },
              completed: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } },
            },
          },
        ],
        active: [{ $match: { status: 'in_progress' } }, { $limit: 1 }],
        lastCompleted: [{ $match: { status: 'completed' } }, { $limit: 1 }],
      },
    },
  ]);

  const activeSession = result?.active[0];
  const lastCompletedSession = result?.lastCompleted[0];
  const completedSessions = result?.totals[0]?.completed ?? 0;
  return {
    bookId,
    status: readingStatusOf(activeSession !== undefined, completedSessions),
    totalSessions: result?.totals[0]?.total ?? 0,
    completedSessions,
    activeSession: activeSession ? toPublicReadingSession(activeSession) : null,
    lastCompletedSession: lastCompletedSession
      ? toPublicReadingSession(lastCompletedSession)
      : null,
  };
}

export async function findReadingSessionOwnedByUser(
  ownerId: string,
  sessionId: string,
): Promise<ReadingSessionDto> {
  const { session } = await findVisibleSession(ownerId, sessionId);
  return toPublicReadingSession(session);
}

/*
 * Cross-field rules (dates, no reopening) are validated against the state the write applies to:
 * the update only matches the revision that was validated, and a concurrent change makes it
 * re-read and re-validate instead of writing over state it never checked.
 */
export async function updateReadingSessionOwnedByUser(
  ownerId: string,
  sessionId: string,
  changes: ReadingSessionChanges,
): Promise<ReadingSessionDto> {
  for (let attempt = 1; attempt <= MAX_UPDATE_ATTEMPTS; attempt += 1) {
    const { session, bookLengths } = await findVisibleSession(ownerId, sessionId);
    if (session.status === 'completed' && changes.status === 'in_progress') {
      throw invalidReadingTransitionError();
    }
    rejectInvalidSessionState(
      {
        status: changes.status ?? session.status,
        startedOn: valueAfterChange(changes.startedOn, session.startedOn),
        completedOn: valueAfterChange(changes.completedOn, session.completedOn),
      },
      changes.progress ?? undefined,
      bookLengths,
    );

    const updatedSession = await ReadingSessionModel.findOneAndUpdate(
      { _id: sessionId, ownerId, revision: session.revision },
      toSessionUpdate(changes),
      { returnDocument: 'after', runValidators: true },
    ).lean();
    if (updatedSession) return toPublicReadingSession(updatedSession);
  }
  throw readingSessionUpdateConflictError();
}
