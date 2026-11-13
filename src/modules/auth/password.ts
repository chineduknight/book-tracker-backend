import { randomBytes } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';

// OWASP Password Storage Cheat Sheet minimum for Argon2id; @node-rs/argon2 defaults to Argon2id.
const ARGON2ID_OPTIONS = { memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

const passwordHashForUnknownAccounts = hashPassword(randomBytes(32).toString('base64url'));

export function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON2ID_OPTIONS);
}

export function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  return verify(passwordHash, password);
}

/** Spends the same Argon2id work as a real check so timing does not reveal unknown accounts. */
export async function verifyPasswordForUnknownAccount(password: string): Promise<void> {
  await verify(await passwordHashForUnknownAccounts, password);
}
