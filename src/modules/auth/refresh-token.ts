import { createHash, randomBytes } from 'node:crypto';

const REFRESH_TOKEN_BYTES = 32;

export function generateRefreshToken(): string {
  return randomBytes(REFRESH_TOKEN_BYTES).toString('base64url');
}

// A fast digest is sufficient because refresh tokens carry 256 random bits; passwords use Argon2id.
export function hashRefreshToken(refreshToken: string): string {
  return createHash('sha256').update(refreshToken).digest('base64url');
}
