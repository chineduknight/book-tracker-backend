import type { Types } from 'mongoose';
import { RefreshTokenModel } from './refresh-token.model.js';
import { generateRefreshToken, hashRefreshToken } from './refresh-token.js';
import { SessionModel, type RevocationReason } from './session.model.js';

const SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;

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

interface SessionRecord {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  expiresAt: Date;
}

function activeSession(sessionId: Types.ObjectId | string, now: Date) {
  return { _id: sessionId, revokedAt: null, expiresAt: { $gt: now } };
}

function revocation(reason: RevocationReason, now: Date) {
  return { $set: { revokedAt: now, revocationReason: reason } };
}

async function issueRefreshToken(session: SessionRecord): Promise<IssuedRefreshToken> {
  const refreshToken = generateRefreshToken();
  await RefreshTokenModel.create({
    sessionId: session._id,
    tokenHash: hashRefreshToken(refreshToken),
    expiresAt: session.expiresAt,
  });
  return {
    userId: session.userId.toHexString(),
    sessionId: session._id.toHexString(),
    refreshToken,
    sessionExpiresAt: session.expiresAt,
  };
}

async function revokeSessionIfRefreshTokenWasConsumed(tokenHash: string, now: Date) {
  const consumedToken = await RefreshTokenModel.findOne({ tokenHash, status: 'consumed' }).lean();
  if (!consumedToken) return;
  await SessionModel.updateOne(
    activeSession(consumedToken.sessionId, now),
    revocation('refresh_token_reuse', now),
  );
}

export async function startSession(userId: string): Promise<IssuedRefreshToken> {
  const session = await SessionModel.create({
    userId,
    expiresAt: new Date(Date.now() + SESSION_LIFETIME_MS),
  });
  return issueRefreshToken(session);
}

export async function rotateRefreshToken(
  presentedRefreshToken: string,
): Promise<IssuedRefreshToken | null> {
  const now = new Date();
  const presentedHash = hashRefreshToken(presentedRefreshToken);

  const consumedToken = await RefreshTokenModel.findOneAndUpdate(
    { tokenHash: presentedHash, status: 'active' },
    { $set: { status: 'consumed', consumedAt: now } },
  ).lean();
  if (!consumedToken) {
    await revokeSessionIfRefreshTokenWasConsumed(presentedHash, now);
    return null;
  }

  const session = await SessionModel.findOneAndUpdate(
    activeSession(consumedToken.sessionId, now),
    { $set: { lastRotatedAt: now } },
    { returnDocument: 'after' },
  ).lean();
  if (!session) return null;

  return issueRefreshToken(session);
}

export async function revokeSessionByRefreshToken(presentedRefreshToken: string): Promise<boolean> {
  const now = new Date();
  const presentedHash = hashRefreshToken(presentedRefreshToken);

  const activeToken = await RefreshTokenModel.findOne({
    tokenHash: presentedHash,
    status: 'active',
  }).lean();
  if (!activeToken) {
    await revokeSessionIfRefreshTokenWasConsumed(presentedHash, now);
    return false;
  }

  const { modifiedCount } = await SessionModel.updateOne(
    activeSession(activeToken.sessionId, now),
    revocation('logout', now),
  );
  return modifiedCount === 1;
}

export async function isSessionActive({ userId, sessionId }: SessionReference): Promise<boolean> {
  const session = await SessionModel.exists({ ...activeSession(sessionId, new Date()), userId });
  return session !== null;
}
