import { model, Schema, type InferSchemaType, type Types } from 'mongoose';
import { PHYSICAL_COPY_CONDITIONS } from './copy.schema.js';

const physicalCopySchema = new Schema(
  {
    ownerId: { type: Schema.Types.ObjectId, required: true },
    bookId: { type: Schema.Types.ObjectId, required: true, immutable: true },
    locationId: { type: Schema.Types.ObjectId, default: null },
    label: { type: String, maxlength: 100 },
    condition: { type: String, enum: PHYSICAL_COPY_CONDITIONS },
    storageNote: { type: String, maxlength: 500 },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true, strict: 'throw' },
);

physicalCopySchema.index(
  { ownerId: 1, bookId: 1, deletedAt: 1, createdAt: -1, _id: -1 },
  { name: 'owner_book_active_recent' },
);
physicalCopySchema.index(
  { ownerId: 1, locationId: 1, deletedAt: 1 },
  { name: 'owner_location_active' },
);

export type PhysicalCopyRecord = InferSchemaType<typeof physicalCopySchema> & {
  _id: Types.ObjectId;
};

export const PhysicalCopyModel = model('PhysicalCopy', physicalCopySchema);
