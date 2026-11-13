/**
 * An error that is safe to show to API clients. Anything that is not an AppError (or a known
 * body-parser error) is reported to the client as a generic 500 with no internal details.
 */
export class AppError extends Error {
  override readonly name = 'AppError';

  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

/** Shape of every error response body. */
export interface ErrorResponseBody {
  error: {
    code: string;
    message: string;
    requestId?: string;
    details?: unknown;
  };
}
