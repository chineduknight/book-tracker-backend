import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { pinoHttp } from 'pino-http';
import { errorSerializer, type Logger } from '../config/logger.js';

export const REQUEST_ID_HEADER = 'x-request-id';

/** Accept a caller-supplied request id only if it is short and free of unsafe characters. */
const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{1,128}$/;

function resolveRequestId(req: IncomingMessage, res: ServerResponse): string {
  const incoming = req.headers[REQUEST_ID_HEADER];
  const id =
    typeof incoming === 'string' && SAFE_REQUEST_ID.test(incoming) ? incoming : randomUUID();
  res.setHeader(REQUEST_ID_HEADER, id);
  return id;
}

/**
 * Assigns a request id (echoed in the X-Request-Id response header) and logs one line per
 * completed request. Only the method and path are logged: query strings, headers and bodies
 * are left out so tokens and credentials cannot leak into logs.
 */
export function requestLogger(logger: Logger) {
  return pinoHttp({
    logger,
    genReqId: resolveRequestId,
    customLogLevel: (_req, res, error) => {
      // 503 is an expected answer from /ready while MongoDB is down; don't flood error logs.
      if (res.statusCode === 503 && !res.err) return 'warn';
      if (error || res.statusCode >= 500) return 'error';
      if (res.statusCode >= 400) return 'warn';
      return 'info';
    },
    serializers: {
      req: (req: { id: unknown; method: string; url: string }) => ({
        id: req.id,
        method: req.method,
        path: req.url.split('?')[0],
      }),
      res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
      // pino-http would otherwise fall back to pino's std serializer (full message + stack).
      err: errorSerializer,
    },
  });
}
