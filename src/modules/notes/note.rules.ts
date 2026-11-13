import type { FieldValidationError } from '../../shared/request-validation.js';
import { toCaseInsensitiveKey } from '../../shared/text.js';
import type { NoteKind } from './note.schema.js';

export const MAX_CONTENT_LENGTH = { note: 20_000, highlight: 5_000 } as const satisfies Record<
  NoteKind,
  number
>;

/** A highlight quotes a passage, so its content is shorter than a note's. */
export function problemsWithContentLength(kind: NoteKind, content: string): FieldValidationError[] {
  const maximum = MAX_CONTENT_LENGTH[kind];
  if (content.length <= maximum) return [];
  return [{ field: 'content', message: `must be at most ${maximum} characters for a ${kind}` }];
}

/** Chapter labels match regardless of case, spacing and Unicode composition. */
export function toChapterKey(chapter: string): string {
  return toCaseInsensitiveKey(chapter);
}
