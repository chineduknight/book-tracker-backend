import { z } from 'zod';

const OBJECT_ID_HEX = /^[0-9a-fA-F]{24}$/;
const POSITIVE_WHOLE_NUMBER = /^[1-9][0-9]*$/;
const ONLY_ONCE = 'must be given only once';

const MAX_PAGE_LIMIT = 100;
const DEFAULT_PAGE_LIMIT = 20;

export const objectIdSchema = z
  .string()
  .regex(OBJECT_ID_HEX, 'must be a 24-character hexadecimal id');

export const singleQueryValue = z.string({
  error: (issue) => (Array.isArray(issue.input) ? ONLY_ONCE : 'must be a single text value'),
});

export function singleQueryChoice<const Choices extends readonly [string, ...string[]]>(
  choices: Choices,
) {
  return z.enum(choices, {
    error: (issue) =>
      Array.isArray(issue.input) ? ONLY_ONCE : `must be one of: ${choices.join(', ')}`,
  });
}

const positiveWholeNumber = singleQueryValue
  .regex(POSITIVE_WHOLE_NUMBER, 'must be a positive whole number')
  .transform(Number)
  .pipe(z.number().int('is too large'));

export const pageQueryParameter = positiveWholeNumber.default(1);
export const limitQueryParameter = positiveWholeNumber
  .pipe(z.number().max(MAX_PAGE_LIMIT))
  .default(DEFAULT_PAGE_LIMIT);
export const objectIdQueryParameter = singleQueryValue.pipe(objectIdSchema);

export function requiringAtLeastOneChange<Changes extends z.ZodObject>(changes: Changes) {
  return changes.refine((value) => Object.keys(value).length > 0, {
    message: 'must change at least one field',
    when: (payload) => payload.issues.length === 0,
  });
}
