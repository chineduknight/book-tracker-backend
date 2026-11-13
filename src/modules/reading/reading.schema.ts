import { z } from 'zod';
import { calendarDateSchema } from '../../shared/calendar-date.js';
import {
  limitQueryParameter,
  objectIdSchema,
  pageQueryParameter,
  requiringAtLeastOneChange,
  singleQueryChoice,
} from '../../shared/request-schemas.js';

export const READING_SESSION_STATUSES = ['in_progress', 'completed'] as const;
export const READING_PROGRESS_UNITS = ['pages', 'chapters', 'percent'] as const;
const READING_HISTORY_SORT_ORDERS = ['recent', 'oldest'] as const;

const status = z.enum(READING_SESSION_STATUSES);
const progress = z.discriminatedUnion('unit', [
  z.strictObject({ unit: z.literal('pages'), value: z.number().int().min(0).max(100_000) }),
  z.strictObject({ unit: z.literal('chapters'), value: z.number().int().min(0).max(10_000) }),
  z.strictObject({ unit: z.literal('percent'), value: z.number().int().min(0).max(100) }),
]);
const rating = z.number().int().min(1).max(5);
const summary = z.string().trim().min(1).max(5_000);

export const startReadingSessionRequestSchema = z
  .strictObject({
    status: status.optional(),
    progress: progress.optional(),
    startedOn: calendarDateSchema.optional(),
    completedOn: calendarDateSchema.optional(),
    rating: rating.optional(),
    summary: summary.optional(),
  })
  .default({});

export const updateReadingSessionRequestSchema = requiringAtLeastOneChange(
  z.strictObject({
    status: status.optional(),
    progress: progress.nullable().optional(),
    startedOn: calendarDateSchema.nullable().optional(),
    completedOn: calendarDateSchema.nullable().optional(),
    rating: rating.nullable().optional(),
    summary: summary.nullable().optional(),
  }),
);

export const readingHistoryQuerySchema = z.strictObject({
  page: pageQueryParameter,
  limit: limitQueryParameter,
  status: singleQueryChoice(READING_SESSION_STATUSES).optional(),
  sort: singleQueryChoice(READING_HISTORY_SORT_ORDERS).default('recent'),
});

export const bookReadingParamsSchema = z.strictObject({ bookId: objectIdSchema });
export const readingSessionIdParamsSchema = z.strictObject({ sessionId: objectIdSchema });

export type ReadingSessionStatus = (typeof READING_SESSION_STATUSES)[number];
export type ReadingProgress = z.output<typeof progress>;
export type NewReadingSession = z.output<typeof startReadingSessionRequestSchema>;
export type ReadingSessionChanges = z.output<typeof updateReadingSessionRequestSchema>;
export type ReadingHistoryQuery = z.output<typeof readingHistoryQuerySchema>;
