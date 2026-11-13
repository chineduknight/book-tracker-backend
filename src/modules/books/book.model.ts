import { model, Schema, type InferSchemaType, type Types } from 'mongoose';
import { BOOK_FORMATS } from './book.schema.js';

const bookSchema = new Schema(
  {
    ownerId: { type: Schema.Types.ObjectId, required: true },
    title: { type: String, required: true, maxlength: 250 },
    authors: { type: [String], default: [] },
    format: { type: String, enum: BOOK_FORMATS, required: true },
    isbn: { type: String, maxlength: 32 },
    edition: { type: String, maxlength: 100 },
    description: { type: String, maxlength: 5_000 },
    coverUrl: { type: String, maxlength: 2_048 },
    pageCount: { type: Number, min: 1, max: 100_000 },
    chapterCount: { type: Number, min: 1, max: 10_000 },
    publicationYear: { type: Number, min: 1, max: 9_999 },
    normalizedTitle: { type: String, required: true },
    normalizedIsbn: { type: String },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true, strict: 'throw' },
);

bookSchema.index(
  { ownerId: 1, deletedAt: 1, createdAt: -1, _id: -1 },
  { name: 'owner_active_recent' },
);
bookSchema.index(
  { ownerId: 1, deletedAt: 1, normalizedTitle: 1, _id: 1 },
  { name: 'owner_active_title' },
);
bookSchema.index(
  { ownerId: 1, deletedAt: 1, normalizedIsbn: 1 },
  { name: 'owner_active_isbn', partialFilterExpression: { normalizedIsbn: { $exists: true } } },
);
bookSchema.index(
  { ownerId: 1, deletedAt: 1, title: 'text', authors: 'text' },
  { name: 'owner_active_text', default_language: 'none' },
);

export type BookRecord = InferSchemaType<typeof bookSchema> & { _id: Types.ObjectId };

export const BookModel = model('Book', bookSchema);
