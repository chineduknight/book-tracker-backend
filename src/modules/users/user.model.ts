import { model, Schema, type InferSchemaType, type Types } from 'mongoose';

const userSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 100 },
    email: { type: String, required: true, trim: true, lowercase: true, maxlength: 254 },
    passwordHash: { type: String, required: true, select: false },
  },
  { timestamps: true, strict: 'throw' },
);

userSchema.index({ email: 1 }, { unique: true });

export type UserRecord = InferSchemaType<typeof userSchema> & { _id: Types.ObjectId };

export const UserModel = model('User', userSchema);
