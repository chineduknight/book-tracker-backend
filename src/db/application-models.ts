import type { Connection, Schema } from 'mongoose';
import { RefreshTokenModel } from '../modules/auth/refresh-token.model.js';
import { SessionModel } from '../modules/auth/session.model.js';
import { BookModel } from '../modules/books/book.model.js';
import { CategoryModel } from '../modules/categories/category.model.js';
import { BookCollectionModel } from '../modules/collections/collection.model.js';
import { PhysicalCopyModel } from '../modules/copies/copy.model.js';
import { LoanModel } from '../modules/loans/loan.model.js';
import { LocationModel } from '../modules/locations/location.model.js';
import { NoteModel } from '../modules/notes/note.model.js';
import { ReadingSessionModel } from '../modules/reading/reading.model.js';
import { UserModel } from '../modules/users/user.model.js';
import { WishlistItemModel } from '../modules/wishlist/wishlist.model.js';

/** What index verification and the operator tools need from a model. */
export interface ApplicationModel {
  readonly modelName: string;
  readonly schema: Schema;
  readonly collection: { readonly collectionName: string };
  init(): Promise<unknown>;
  diffIndexes(options: { indexOptionsToCreate: true }): Promise<{
    toCreate: unknown[];
    toDrop: unknown[];
  }>;
}

/** Every model that owns a collection. Their schemas are the source of truth for indexes. */
export const APPLICATION_MODELS: readonly ApplicationModel[] = [
  UserModel,
  SessionModel,
  RefreshTokenModel,
  BookModel,
  LocationModel,
  PhysicalCopyModel,
  ReadingSessionModel,
  NoteModel,
  CategoryModel,
  BookCollectionModel,
  WishlistItemModel,
  LoanModel,
];

/**
 * The application models bound to `connection`. Operator tools inspect other databases through
 * their own connection, which must be opened with `autoIndex: false` so that binding a model
 * never builds an index as a side effect.
 */
export function applicationModelsOn(connection: Connection): ApplicationModel[] {
  return APPLICATION_MODELS.map(
    (model): ApplicationModel =>
      connection.models[model.modelName] ??
      connection.model(model.modelName, model.schema, model.collection.collectionName),
  );
}
