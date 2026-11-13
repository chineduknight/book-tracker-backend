import { Router, type Request, type RequestHandler } from 'express';
import {
  parseRequestBody,
  parseRequestQuery,
  parseRouteParams,
} from '../../shared/request-validation.js';
import { authenticatedUserOf } from '../auth/auth.middleware.js';
import type { NoteListResponseBody, NoteResponseBody } from './note.dto.js';
import {
  allNotesQuerySchema,
  bookNotesParamsSchema,
  bookNotesQuerySchema,
  createNoteRequestSchema,
  noteIdParamsSchema,
  updateNoteRequestSchema,
} from './note.schema.js';
import {
  createNote,
  deleteNoteOwnedByUser,
  findNoteOwnedByUser,
  listNotesOfBook,
  listNotesOfOwner,
  updateNoteOwnedByUser,
} from './note.service.js';

export interface NotesRouterDependencies {
  requireAuthenticatedUser: RequestHandler;
}

function ownerIdOf(req: Request): string {
  return authenticatedUserOf(req).userId;
}

function bookIdOf(req: Request): string {
  return parseRouteParams(bookNotesParamsSchema, req.params).bookId;
}

function noteIdOf(req: Request): string {
  return parseRouteParams(noteIdParamsSchema, req.params).noteId;
}

/** Serves book-scoped and global note routes; mount it before the books router. */
export function createNotesRouter({ requireAuthenticatedUser }: NotesRouterDependencies): Router {
  const notesRouter = Router();

  notesRouter.post('/books/:bookId/notes', requireAuthenticatedUser, async (req, res) => {
    const bookId = bookIdOf(req);
    const newNote = parseRequestBody(createNoteRequestSchema, req.body);
    const note = await createNote(ownerIdOf(req), bookId, newNote);
    res
      .status(201)
      .location(`${req.baseUrl}/notes/${note.id}`)
      .json({ data: note } satisfies NoteResponseBody);
  });

  notesRouter.get('/books/:bookId/notes', requireAuthenticatedUser, async (req, res) => {
    const bookId = bookIdOf(req);
    const notesQuery = parseRequestQuery(bookNotesQuerySchema, req.query);
    const { notes, pagination } = await listNotesOfBook(ownerIdOf(req), bookId, notesQuery);
    res.status(200).json({ data: notes, meta: { pagination } } satisfies NoteListResponseBody);
  });

  notesRouter.get('/notes', requireAuthenticatedUser, async (req, res) => {
    const notesQuery = parseRequestQuery(allNotesQuerySchema, req.query);
    const { notes, pagination } = await listNotesOfOwner(ownerIdOf(req), notesQuery);
    res.status(200).json({ data: notes, meta: { pagination } } satisfies NoteListResponseBody);
  });

  notesRouter.get('/notes/:noteId', requireAuthenticatedUser, async (req, res) => {
    const note = await findNoteOwnedByUser(ownerIdOf(req), noteIdOf(req));
    res.status(200).json({ data: note } satisfies NoteResponseBody);
  });

  notesRouter.patch('/notes/:noteId', requireAuthenticatedUser, async (req, res) => {
    const noteId = noteIdOf(req);
    const changes = parseRequestBody(updateNoteRequestSchema, req.body);
    const note = await updateNoteOwnedByUser(ownerIdOf(req), noteId, changes);
    res.status(200).json({ data: note } satisfies NoteResponseBody);
  });

  notesRouter.delete('/notes/:noteId', requireAuthenticatedUser, async (req, res) => {
    await deleteNoteOwnedByUser(ownerIdOf(req), noteIdOf(req));
    res.status(204).end();
  });

  return notesRouter;
}
