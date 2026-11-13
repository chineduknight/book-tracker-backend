import { model, Schema, type InferSchemaType, type Types } from 'mongoose';

const locationSchema = new Schema(
  {
    ownerId: { type: Schema.Types.ObjectId, required: true },
    name: { type: String, required: true, maxlength: 100 },
    normalizedName: { type: String, required: true },
    description: { type: String, maxlength: 500 },
  },
  { timestamps: true, strict: 'throw' },
);

locationSchema.index(
  { ownerId: 1, normalizedName: 1 },
  { unique: true, name: 'owner_unique_name' },
);

export type LocationRecord = InferSchemaType<typeof locationSchema> & { _id: Types.ObjectId };

export const LocationModel = model('Location', locationSchema);
