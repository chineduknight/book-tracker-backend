/**
 * Error details that are safe to write to logs or stderr.
 *
 * Error messages, stacks, causes and arbitrary properties are deliberately dropped: they are
 * untrusted text that can embed credentials or full connection strings (MongoDB driver errors,
 * for example, can include the URI). Only the error class name and a machine-readable code are
 * kept, and only when they look like identifiers. Correlate with the request id or log context to
 * investigate.
 */
export interface SafeError {
  name: string;
  code?: string | number;
}

/** Class names such as `TypeError` or `MongoServerSelectionError`. */
const SAFE_NAME = /^[A-Za-z][A-Za-z0-9]{0,63}$/;
/** Codes such as `ECONNREFUSED` or `ERR_SERVER_NOT_RUNNING`. */
const SAFE_STRING_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;

/**
 * pino's std error serializer (which pino-http wraps around custom serializers) passes an
 * already-serialized object with the original error on `raw`. Unwrap it so both paths agree.
 */
function unwrap(value: unknown): unknown {
  if (typeof value === 'object' && value !== null && 'raw' in value && value.raw instanceof Error) {
    return value.raw;
  }
  return value;
}

export function toSafeError(value: unknown): SafeError {
  const error = unwrap(value);
  if (!(error instanceof Error)) return { name: 'NonErrorThrown' };

  const name = SAFE_NAME.test(error.name) ? error.name : 'Error';
  const code: unknown = 'code' in error ? error.code : undefined;
  if (typeof code === 'number' && Number.isInteger(code)) return { name, code };
  if (typeof code === 'string' && SAFE_STRING_CODE.test(code)) return { name, code };
  return { name };
}

/** One-line safe description for places without a logger (e.g. stderr before startup). */
export function formatSafeError(value: unknown): string {
  const { name, code } = toSafeError(value);
  return code === undefined ? name : `${name} (${String(code)})`;
}
