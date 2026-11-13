import type { z } from 'zod';
import { AppError } from './errors.js';

export interface FieldValidationError {
  field: string;
  message: string;
}

function toFieldValidationErrors(
  issues: readonly z.core.$ZodIssue[],
  wholeInputField: string,
): FieldValidationError[] {
  return issues.flatMap((issue) => {
    if (issue.code === 'unrecognized_keys') {
      return issue.keys.map((key) => ({ field: key, message: 'Unknown field' }));
    }
    return [{ field: issue.path.map(String).join('.') || wholeInputField, message: issue.message }];
  });
}

function parseOrRejectAsInvalid<Schema extends z.ZodType>(
  schema: Schema,
  input: unknown,
  wholeInputField: string,
): z.output<Schema> {
  const result = schema.safeParse(input);
  if (result.success) return result.data;

  throw new AppError(
    400,
    'VALIDATION_ERROR',
    'The request contains invalid fields',
    toFieldValidationErrors(result.error.issues, wholeInputField),
  );
}

export function parseRequestBody<Schema extends z.ZodType>(
  schema: Schema,
  body: unknown,
): z.output<Schema> {
  return parseOrRejectAsInvalid(schema, body, 'body');
}

export function parseRequestQuery<Schema extends z.ZodType>(
  schema: Schema,
  query: unknown,
): z.output<Schema> {
  return parseOrRejectAsInvalid(schema, query, 'query');
}

export function parseRouteParams<Schema extends z.ZodType>(
  schema: Schema,
  params: unknown,
): z.output<Schema> {
  return parseOrRejectAsInvalid(schema, params, 'params');
}
