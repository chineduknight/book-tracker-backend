import type { z } from 'zod';
import { AppError } from './errors.js';

export interface FieldValidationError {
  field: string;
  message: string;
}

function toFieldValidationErrors(issues: readonly z.core.$ZodIssue[]): FieldValidationError[] {
  return issues.flatMap((issue) => {
    if (issue.code === 'unrecognized_keys') {
      return issue.keys.map((key) => ({ field: key, message: 'Unknown field' }));
    }
    return [{ field: issue.path.map(String).join('.') || 'body', message: issue.message }];
  });
}

export function parseRequestBody<Schema extends z.ZodType>(
  schema: Schema,
  body: unknown,
): z.output<Schema> {
  const result = schema.safeParse(body);
  if (result.success) return result.data;

  throw new AppError(
    400,
    'VALIDATION_ERROR',
    'The request contains invalid fields',
    toFieldValidationErrors(result.error.issues),
  );
}
