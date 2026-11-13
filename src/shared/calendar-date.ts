import { z } from 'zod';

const CALENDAR_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isExistingCalendarDate(text: string): boolean {
  const parts = CALENDAR_DATE.exec(text);
  if (!parts) return false;
  const [year, month, day] = parts.slice(1).map(Number) as [number, number, number];
  if (year < 1) return false;

  const date = new Date(Date.UTC(2000, month - 1, day));
  date.setUTCFullYear(year);
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

/** A calendar day as entered by the reader, kept as `YYYY-MM-DD` with no time zone applied. */
export const calendarDateSchema = z
  .string()
  .refine(isExistingCalendarDate, 'must be an existing calendar date in YYYY-MM-DD format');
