import { model, Schema, type InferSchemaType, type Types } from 'mongoose';
import {
  WISHLIST_PREFERRED_FORMATS,
  WISHLIST_PRIORITIES,
  WISHLIST_STATUSES,
} from './wishlist.schema.js';

const wishlistItemSchema = new Schema(
  {
    ownerId: { type: Schema.Types.ObjectId, required: true, immutable: true },
    title: { type: String, required: true, maxlength: 250 },
    normalizedTitle: { type: String, required: true },
    authors: { type: [String], default: [] },
    isbn: { type: String, maxlength: 32 },
    preferredFormat: { type: String, enum: WISHLIST_PREFERRED_FORMATS },
    coverUrl: { type: String, maxlength: 2_048 },
    sourceUrl: { type: String, maxlength: 2_048 },
    priority: { type: String, enum: WISHLIST_PRIORITIES, required: true, default: 'medium' },
    priorityRank: { type: Number, required: true, min: 0, max: 2 },
    note: { type: String, maxlength: 2_000 },
    status: { type: String, enum: WISHLIST_STATUSES, required: true, default: 'wanted' },
    acquiredBookId: { type: Schema.Types.ObjectId, default: null },
    acquiredAt: { type: Date },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true, strict: 'throw' },
);

wishlistItemSchema.index(
  { ownerId: 1, deletedAt: 1, status: 1, createdAt: -1, _id: -1 },
  { name: 'owner_active_status_recent' },
);
wishlistItemSchema.index(
  { ownerId: 1, deletedAt: 1, normalizedTitle: 1, _id: 1 },
  { name: 'owner_active_title' },
);
wishlistItemSchema.index(
  { ownerId: 1, deletedAt: 1, priorityRank: 1, createdAt: -1, _id: -1 },
  { name: 'owner_active_priority' },
);
wishlistItemSchema.index(
  { ownerId: 1, deletedAt: 1, title: 'text', authors: 'text', note: 'text' },
  { name: 'owner_active_text', default_language: 'none' },
);

export type WishlistItemRecord = InferSchemaType<typeof wishlistItemSchema> & {
  _id: Types.ObjectId;
};

export const WishlistItemModel = model('WishlistItem', wishlistItemSchema);
