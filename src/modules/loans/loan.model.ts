import { model, Schema, type InferSchemaType, type Types } from 'mongoose';

const loanSchema = new Schema(
  {
    ownerId: { type: Schema.Types.ObjectId, required: true, immutable: true },
    copyId: { type: Schema.Types.ObjectId, required: true, immutable: true },
    bookId: { type: Schema.Types.ObjectId, required: true, immutable: true },
    borrowerName: { type: String, required: true, maxlength: 160 },
    borrowerContact: { type: String, maxlength: 200 },
    lentOn: { type: String, required: true },
    dueOn: { type: String },
    returnedOn: { type: String, default: null },
    note: { type: String, maxlength: 2_000 },
    revision: { type: Number, required: true, default: 0, min: 0 },
  },
  { timestamps: true, strict: 'throw' },
);

loanSchema.index(
  { ownerId: 1, copyId: 1 },
  { name: 'owner_copy_single_active', unique: true, partialFilterExpression: { returnedOn: null } },
);
loanSchema.index({ ownerId: 1, copyId: 1, createdAt: -1, _id: -1 }, { name: 'owner_copy_recent' });
loanSchema.index({ ownerId: 1, createdAt: -1, _id: -1 }, { name: 'owner_recent' });
loanSchema.index(
  { ownerId: 1, returnedOn: 1, createdAt: -1, _id: -1 },
  { name: 'owner_returned_recent' },
);

export type LoanRecord = InferSchemaType<typeof loanSchema> & { _id: Types.ObjectId };

export const LoanModel = model('Loan', loanSchema);
