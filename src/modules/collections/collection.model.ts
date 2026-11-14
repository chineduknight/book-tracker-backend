import { model, Schema, type InferSchemaType, type Types } from 'mongoose';

function hasNoDuplicateIds(ids: Types.ObjectId[]): boolean {
  return new Set(ids.map((id) => id.toHexString())).size === ids.length;
}

const bookCollectionSchema = new Schema(
  {
    ownerId: { type: Schema.Types.ObjectId, required: true, immutable: true },
    name: { type: String, required: true, maxlength: 100 },
    normalizedName: { type: String, required: true },
    description: { type: String, maxlength: 500 },
    bookIds: {
      type: [Schema.Types.ObjectId],
      default: [],
      validate: { validator: hasNoDuplicateIds, message: 'bookIds must not repeat a book' },
    },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true, strict: 'throw' },
);

bookCollectionSchema.index(
  { ownerId: 1, normalizedName: 1 },
  { unique: true, partialFilterExpression: { deletedAt: null }, name: 'owner_active_unique_name' },
);
bookCollectionSchema.index(
  { ownerId: 1, deletedAt: 1, normalizedName: 1, _id: 1 },
  { name: 'owner_active_alphabetical' },
);
bookCollectionSchema.index(
  { ownerId: 1, deletedAt: 1, bookIds: 1 },
  { name: 'owner_active_books' },
);

export type BookCollectionRecord = InferSchemaType<typeof bookCollectionSchema> & {
  _id: Types.ObjectId;
};

export const BookCollectionModel = model('BookCollection', bookCollectionSchema);
