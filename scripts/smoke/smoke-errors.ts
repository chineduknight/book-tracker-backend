import { formatSafeError } from '../../src/shared/safe-error.js';
import { UnsafeDatabaseTargetError } from '../local-database-target.js';

/** A failure described by the smoke runner itself; its message never contains input values. */
export class SmokeRunError extends Error {
  override readonly name = 'SmokeRunError';
}

export function describeSmokeFailure(error: unknown): string {
  if (error instanceof SmokeRunError || error instanceof UnsafeDatabaseTargetError) {
    return error.message;
  }
  return formatSafeError(error);
}
