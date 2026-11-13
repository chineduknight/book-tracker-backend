import { model, Schema, type InferSchemaType, type Types } from 'mongoose';
import { READING_PROGRESS_UNITS, READING_SESSION_STATUSES } from './reading.schema.js';

const readingProgressSchema = new Schema(
  {
    unit: { type: String, enum: READING_PROGRESS_UNITS, required: true },
    value: { type: Number, required: true, min: 0 },
  },
  { _id: false, strict: 'throw' },
);

const readingSessionSchema = new Schema(
  {
    ownerId: { type: Schema.Types.ObjectId, required: true, immutable: true },
    bookId: { type: Schema.Types.ObjectId, required: true, immutable: true },
    status: {
      type: String,
      enum: READING_SESSION_STATUSES,
      required: true,
      default: 'in_progress',
    },
    progress: { type: readingProgressSchema, default: null },
    startedOn: { type: String },
    completedOn: { type: String },
    rating: { type: Number, min: 1, max: 5 },
    summary: { type: String, maxlength: 5_000 },
    revision: { type: Number, required: true, default: 0 },
  },
  { timestamps: true, strict: 'throw' },
);

readingSessionSchema.index(
  { ownerId: 1, bookId: 1, createdAt: -1, _id: -1 },
  { name: 'owner_book_recent' },
);
readingSessionSchema.index(
  { ownerId: 1, status: 1, createdAt: -1, _id: -1 },
  { name: 'owner_status_recent' },
);
readingSessionSchema.index({ ownerId: 1, createdAt: -1, _id: -1 }, { name: 'owner_recent' });
readingSessionSchema.index(
  { ownerId: 1, bookId: 1 },
  {
    name: 'owner_book_single_in_progress',
    unique: true,
    partialFilterExpression: { status: 'in_progress' },
  },
);

export type ReadingSessionRecord = InferSchemaType<typeof readingSessionSchema> & {
  _id: Types.ObjectId;
};

export const ReadingSessionModel = model('ReadingSession', readingSessionSchema);
