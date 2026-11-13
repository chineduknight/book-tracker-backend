import type { PaginatedResponseBody, SuccessResponseBody } from '../../shared/api-response.js';
import type { NoteRecord } from './note.model.js';

export type NoteKindDto = 'note' | 'highlight';

export interface NoteDto {
  id: string;
  bookId: string;
  readingSessionId: string | null;
  kind: NoteKindDto;
  content: string;
  title?: string;
  commentary?: string;
  chapter?: string;
  pageNumber?: number;
  createdAt: string;
  updatedAt: string;
}

export type NoteResponseBody = SuccessResponseBody<NoteDto>;
export type NoteListResponseBody = PaginatedResponseBody<NoteDto>;

export function toPublicNote(note: NoteRecord): NoteDto {
  return {
    id: note._id.toHexString(),
    bookId: note.bookId.toHexString(),
    readingSessionId: note.readingSessionId?.toHexString() ?? null,
    kind: note.kind,
    content: note.content,
    ...(note.title != null && { title: note.title }),
    ...(note.commentary != null && { commentary: note.commentary }),
    ...(note.chapter != null && { chapter: note.chapter }),
    ...(note.pageNumber != null && { pageNumber: note.pageNumber }),
    createdAt: note.createdAt.toISOString(),
    updatedAt: note.updatedAt.toISOString(),
  };
}
