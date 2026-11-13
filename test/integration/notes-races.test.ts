import { describe, expect, it } from 'vitest';
import { NoteModel } from '../../src/modules/notes/note.model.js';
import { createAuthTestApp } from './auth-fixtures.js';
import {
  addNote,
  addPhysicalBook,
  expectNotFound,
  paginationOf,
  signInLibraryReader,
} from './library-fixtures.js';

const ROUNDS = 10;

describe('concurrent note changes', () => {
  it('never resurrects a note when PATCH and DELETE race', async () => {
    const reader = await signInLibraryReader(createAuthTestApp());
    const book = await addPhysicalBook(reader);

    for (let round = 0; round < ROUNDS; round += 1) {
      const note = await addNote(reader, book.id);

      const [update, removal] = await Promise.all([
        reader.notes.update(note.id, { title: `Edited in round ${round}` }),
        reader.notes.remove(note.id),
      ]);

      expect(removal.status).toBe(204);
      expect([200, 404]).toContain(update.status);
      expect((await NoteModel.findById(note.id).orFail().lean()).deletedAt).toBeInstanceOf(Date);
      expectNotFound(await reader.notes.get(note.id), 'Note not found');
    }
  });

  it('keeps every field when concurrent PATCHes change different fields', async () => {
    const reader = await signInLibraryReader(createAuthTestApp());
    const book = await addPhysicalBook(reader);

    for (let round = 0; round < ROUNDS; round += 1) {
      const note = await addNote(reader, book.id);

      const responses = await Promise.all([
        reader.notes.update(note.id, { title: `Title ${round}` }),
        reader.notes.update(note.id, { commentary: `Commentary ${round}` }),
        reader.notes.update(note.id, { chapter: `Chapter ${round}` }),
        reader.notes.update(note.id, { pageNumber: round + 1 }),
      ]);

      expect(responses.map((res) => res.status)).toEqual([200, 200, 200, 200]);
      expect((await reader.notes.get(note.id)).body.data).toMatchObject({
        title: `Title ${round}`,
        commentary: `Commentary ${round}`,
        chapter: `Chapter ${round}`,
        pageNumber: round + 1,
      });
    }
  });

  it('keeps notes created while their book is deleted, hidden and unchanged', async () => {
    const reader = await signInLibraryReader(createAuthTestApp());

    for (let round = 0; round < ROUNDS; round += 1) {
      const book = await addPhysicalBook(reader, `Race ${round}`);

      const [removal, ...creations] = await Promise.all([
        reader.books.remove(book.id),
        ...Array.from({ length: 4 }, (_, index) =>
          reader.notes.create(book.id, { kind: 'note', content: `Race ${round}.${index}` }),
        ),
      ]);

      expect(removal.status).toBe(204);
      for (const creation of creations) expect([201, 404]).toContain(creation.status);
      const storedNotes = await NoteModel.find({ bookId: book.id }).lean();
      expect(storedNotes).toHaveLength(creations.filter((res) => res.status === 201).length);
      for (const stored of storedNotes) {
        expect(stored.deletedAt).toBeNull();
        expectNotFound(await reader.notes.get(stored._id.toHexString()), 'Note not found');
      }
    }
    expect(paginationOf(await reader.notes.listAll()).total).toBe(0);
  });
});
