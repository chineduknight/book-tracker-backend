import { model, Schema } from 'mongoose';

const REFRESH_TOKEN_STATUSES = ['active', 'consumed'] as const;

const refreshTokenSchema = new Schema(
  {
    sessionId: { type: Schema.Types.ObjectId, required: true },
    tokenHash: { type: String, required: true },
    status: { type: String, enum: REFRESH_TOKEN_STATUSES, required: true, default: 'active' },
    consumedAt: { type: Date, default: null },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false }, strict: 'throw' },
);

refreshTokenSchema.index({ tokenHash: 1 }, { unique: true });
refreshTokenSchema.index(
  { sessionId: 1 },
  { unique: true, partialFilterExpression: { status: 'active' } },
);
refreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const RefreshTokenModel = model('RefreshToken', refreshTokenSchema);
