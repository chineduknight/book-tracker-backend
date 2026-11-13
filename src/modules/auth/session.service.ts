import { generateRefreshToken, hashRefreshToken } from './refresh-token.js';
import { SessionModel, type RevocationReason } from './session.model.js';

const SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
const RETAINED_CONSUMED_REFRESH_TOKENS = 100;

export interface IssuedRefreshToken {
  userId: string;
  sessionId: string;
  refreshToken: string;
  sessionExpiresAt: Date;
}

export interface SessionReference {
  userId: string;
  sessionId: string;
}

function activeSessionHolding(refreshTokenHash: string, now: Date) {
  return { refreshTokenHash, revokedAt: null, expiresAt: { $gt: now } };
}

function revocation(reason: RevocationReason, now: Date) {
  return { $set: { revokedAt: now, revocationReason: reason } };
}

async function revokeSessionIfRefreshTokenWasConsumed(refreshTokenHash: string, now: Date) {
  await SessionModel.updateOne(
    { consumedRefreshTokenHashes: refreshTokenHash, revokedAt: null },
    revocation('refresh_token_reuse', now),
  );
}

export async function startSession(userId: string): Promise<IssuedRefreshToken> {
  const refreshToken = generateRefreshToken();
  const session = await SessionModel.create({
    userId,
    refreshTokenHash: hashRefreshToken(refreshToken),
    expiresAt: new Date(Date.now() + SESSION_LIFETIME_MS),
  });
  return {
    userId,
    sessionId: session.id,
    refreshToken,
    sessionExpiresAt: session.expiresAt,
  };
}

export async function rotateRefreshToken(
  presentedRefreshToken: string,
): Promise<IssuedRefreshToken | null> {
  const now = new Date();
  const presentedHash = hashRefreshToken(presentedRefreshToken);
  const replacementRefreshToken = generateRefreshToken();

  const session = await SessionModel.findOneAndUpdate(
    activeSessionHolding(presentedHash, now),
    {
      $set: { refreshTokenHash: hashRefreshToken(replacementRefreshToken), lastRotatedAt: now },
      $push: {
        consumedRefreshTokenHashes: {
          $each: [presentedHash],
          $slice: -RETAINED_CONSUMED_REFRESH_TOKENS,
        },
      },
    },
    { returnDocument: 'after' },
  ).lean();

  if (!session) {
    await revokeSessionIfRefreshTokenWasConsumed(presentedHash, now);
    return null;
  }
  return {
    userId: session.userId.toHexString(),
    sessionId: session._id.toHexString(),
    refreshToken: replacementRefreshToken,
    sessionExpiresAt: session.expiresAt,
  };
}

export async function revokeSessionByRefreshToken(presentedRefreshToken: string): Promise<boolean> {
  const now = new Date();
  const presentedHash = hashRefreshToken(presentedRefreshToken);

  const { modifiedCount } = await SessionModel.updateOne(
    activeSessionHolding(presentedHash, now),
    revocation('logout', now),
  );
  if (modifiedCount === 1) return true;

  await revokeSessionIfRefreshTokenWasConsumed(presentedHash, now);
  return false;
}

export async function isSessionActive({ userId, sessionId }: SessionReference): Promise<boolean> {
  const activeSession = await SessionModel.exists({
    _id: sessionId,
    userId,
    revokedAt: null,
    expiresAt: { $gt: new Date() },
  });
  return activeSession !== null;
}
