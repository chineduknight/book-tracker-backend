import { z } from 'zod';
import { calendarDateSchema } from '../../shared/calendar-date.js';
import { positiveWholeNumberQueryValue, singleQueryValue } from '../../shared/request-schemas.js';

const MAX_ACTIVITY_LIMIT = 20;
const DEFAULT_ACTIVITY_LIMIT = 10;

export const summaryQuerySchema = z.strictObject({
  asOf: singleQueryValue.pipe(calendarDateSchema).optional(),
});

export const readingStatisticsQuerySchema = z.strictObject({});

export const recentActivityQuerySchema = z.strictObject({
  limit: positiveWholeNumberQueryValue
    .pipe(z.number().max(MAX_ACTIVITY_LIMIT))
    .default(DEFAULT_ACTIVITY_LIMIT),
});

export type SummaryQuery = z.output<typeof summaryQuerySchema>;
export type RecentActivityQuery = z.output<typeof recentActivityQuerySchema>;
