import { model, Schema } from 'mongoose';

const REVOCATION_REASONS = ['logout', 'refresh_token_reuse'] as const;
export type RevocationReason = (typeof REVOCATION_REASONS)[number];

const sessionSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, required: true, index: true },
    expiresAt: { type: Date, required: true },
    lastRotatedAt: { type: Date, default: null },
    revokedAt: { type: Date, default: null },
    revocationReason: { type: String, enum: REVOCATION_REASONS, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false }, strict: 'throw' },
);

sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const SessionModel = model('Session', sessionSchema);
