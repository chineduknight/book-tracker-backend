import { model, Schema, type InferSchemaType, type Types } from 'mongoose';
import { MAX_CONTENT_LENGTH } from './note.rules.js';
import { NOTE_KINDS } from './note.schema.js';

const noteSchema = new Schema(
  {
    ownerId: { type: Schema.Types.ObjectId, required: true, immutable: true },
    bookId: { type: Schema.Types.ObjectId, required: true, immutable: true },
    readingSessionId: { type: Schema.Types.ObjectId, default: null, immutable: true },
    kind: { type: String, enum: NOTE_KINDS, required: true, immutable: true },
    content: { type: String, required: true, maxlength: MAX_CONTENT_LENGTH.note },
    title: { type: String, maxlength: 160 },
    commentary: { type: String, maxlength: 5_000 },
    chapter: { type: String, maxlength: 200 },
    chapterKey: { type: String },
    pageNumber: { type: Number, min: 1, max: 100_000 },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true, strict: 'throw' },
);

noteSchema.index(
  { ownerId: 1, bookId: 1, deletedAt: 1, createdAt: -1, _id: -1 },
  { name: 'owner_book_active_recent' },
);
noteSchema.index(
  { ownerId: 1, deletedAt: 1, createdAt: -1, _id: -1 },
  { name: 'owner_active_recent' },
);
noteSchema.index(
  { ownerId: 1, readingSessionId: 1, deletedAt: 1, createdAt: -1, _id: -1 },
  { name: 'owner_session_active_recent' },
);
noteSchema.index(
  {
    ownerId: 1,
    deletedAt: 1,
    title: 'text',
    content: 'text',
    commentary: 'text',
    chapter: 'text',
  },
  { name: 'owner_active_text', default_language: 'none' },
);

export type NoteRecord = InferSchemaType<typeof noteSchema> & { _id: Types.ObjectId };

export const NoteModel = model('Note', noteSchema);
