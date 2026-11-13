import type { ErrorRequestHandler, Request, RequestHandler } from 'express';
import { AppError, type ErrorResponseBody } from '../shared/errors.js';

/** Errors raised by Express's body parser carry an HTTP status and a `type`. */
interface ClientHttpError extends Error {
  status: number;
  type?: string;
}

function isClientHttpError(error: unknown): error is ClientHttpError {
  if (!(error instanceof Error) || !('status' in error)) return false;
  const { status } = error;
  return typeof status === 'number' && status >= 400 && status < 500;
}

function fromClientHttpError(error: ClientHttpError): AppError {
  switch (error.type) {
    case 'entity.parse.failed':
      return new AppError(400, 'INVALID_JSON', 'Request body is not valid JSON');
    case 'entity.too.large':
      return new AppError(413, 'PAYLOAD_TOO_LARGE', 'Request body exceeds the size limit');
    case 'charset.unsupported':
    case 'encoding.unsupported':
      return new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Request body encoding is not supported');
    default:
      return new AppError(error.status, 'BAD_REQUEST', 'The request could not be processed');
  }
}

function requestIdOf(req: Request): string | undefined {
  return typeof req.id === 'string' ? req.id : undefined;
}

export const notFoundHandler: RequestHandler = (_req, _res, next) => {
  next(new AppError(404, 'NOT_FOUND', 'Route not found'));
};

export const errorHandler: ErrorRequestHandler = (error: unknown, req, res, next) => {
  if (res.headersSent) {
    next(error);
    return;
  }

  let appError: AppError;
  if (error instanceof AppError) {
    appError = error;
  } else if (isClientHttpError(error)) {
    appError = fromClientHttpError(error);
  } else {
    // Unexpected: pino-http adds it to the request log line through the safe error serializer
    // (name and code only). Nothing about it reaches the response.
    res.err = error instanceof Error ? error : new Error('Non-error value thrown');
    appError = new AppError(500, 'INTERNAL_ERROR', 'An unexpected error occurred');
  }

  const requestId = requestIdOf(req);
  const body: ErrorResponseBody = {
    error: {
      code: appError.code,
      message: appError.message,
      ...(requestId !== undefined && { requestId }),
      ...(appError.details !== undefined && { details: appError.details }),
    },
  };
  res.status(appError.statusCode).json(body);
};
