import { formatSafeError } from '../../src/shared/safe-error.js';

/** A failure described by the smoke runner itself; its message never contains input values. */
export class SmokeRunError extends Error {
  override readonly name = 'SmokeRunError';
}

export function describeSmokeFailure(error: unknown): string {
  return error instanceof SmokeRunError ? error.message : formatSafeError(error);
}
