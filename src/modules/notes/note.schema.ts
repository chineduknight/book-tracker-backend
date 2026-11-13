import { z } from 'zod';
import {
  limitQueryParameter,
  objectIdQueryParameter,
  objectIdSchema,
  pageQueryParameter,
  requiringAtLeastOneChange,
  singleQueryChoice,
  singleQueryValue,
  textSearchQueryParameter,
} from '../../shared/request-schemas.js';
import { MAX_CONTENT_LENGTH, problemsWithContentLength } from './note.rules.js';

export const NOTE_KINDS = ['note', 'highlight'] as const;
const NOTE_SORT_ORDERS = ['recent', 'oldest'] as const;

const kind = z.enum(NOTE_KINDS);
const isIssueWithKindOrContent = (issue: z.core.$ZodRawIssue) =>
  issue.path?.[0] === 'kind' || issue.path?.[0] === 'content';
const content = z.string().trim().min(1).max(MAX_CONTENT_LENGTH.note);
const title = z.string().trim().min(1).max(160);
const commentary = z.string().trim().min(1).max(5_000);
const chapter = z.string().trim().min(1).max(200);
const pageNumber = z.number().int().min(1).max(100_000);

export const createNoteRequestSchema = z
  .strictObject({
    kind,
    content,
    title: title.optional(),
    commentary: commentary.optional(),
    chapter: chapter.optional(),
    pageNumber: pageNumber.optional(),
    readingSessionId: objectIdSchema.nullable().optional(),
  })
  .superRefine(
    (newNote, context) => {
      for (const problem of problemsWithContentLength(newNote.kind, newNote.content)) {
        context.addIssue({ code: 'custom', path: [problem.field], message: problem.message });
      }
    },
    { when: (payload) => !payload.issues.some(isIssueWithKindOrContent) },
  );

export const updateNoteRequestSchema = requiringAtLeastOneChange(
  z.strictObject({
    content: content.optional(),
    title: title.nullable().optional(),
    commentary: commentary.nullable().optional(),
    chapter: chapter.nullable().optional(),
    pageNumber: pageNumber.nullable().optional(),
  }),
);

export const bookNotesQuerySchema = z.strictObject({
  page: pageQueryParameter,
  limit: limitQueryParameter,
  sort: singleQueryChoice(NOTE_SORT_ORDERS).default('recent'),
  kind: singleQueryChoice(NOTE_KINDS).optional(),
  q: textSearchQueryParameter.optional(),
  chapter: singleQueryValue.pipe(chapter).optional(),
  readingSessionId: objectIdQueryParameter.optional(),
});

export const allNotesQuerySchema = bookNotesQuerySchema.extend({
  bookId: objectIdQueryParameter.optional(),
});

export const bookNotesParamsSchema = z.strictObject({ bookId: objectIdSchema });
export const noteIdParamsSchema = z.strictObject({ noteId: objectIdSchema });

export type NoteKind = (typeof NOTE_KINDS)[number];
export type NewNote = z.output<typeof createNoteRequestSchema>;
export type NoteChanges = z.output<typeof updateNoteRequestSchema>;
export type BookNotesQuery = z.output<typeof bookNotesQuerySchema>;
export type AllNotesQuery = z.output<typeof allNotesQuerySchema>;
