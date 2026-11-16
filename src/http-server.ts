import { createServer, type RequestListener, type Server } from 'node:http';

export interface HttpServerTimeouts {
  /** Time a client has to send the complete request headers. */
  headersTimeoutMs: number;
  /** Time a client has to send the complete request, headers and body. Responses are not covered. */
  requestTimeoutMs: number;
  /** How often Node enforces the two limits above, so they take effect within this margin. */
  connectionsCheckIntervalMs: number;
  /**
   * How long an idle keep-alive connection stays open between requests. Longer than the hosting
   * proxy's own idle timeout, so the proxy, not the API, closes idle upstream connections.
   */
  keepAliveTimeoutMs: number;
  /**
   * A connection with no socket activity for this long while a request is being served is
   * destroyed, for example a client that stopped reading a download (up to 32 MiB held in memory).
   */
  socketIdleTimeoutMs: number;
}

/** See docs/deployment-runbook.md for how these relate to the hosting proxy's budgets. */
export const HTTP_SERVER_TIMEOUTS: HttpServerTimeouts = {
  headersTimeoutMs: 20_000,
  requestTimeoutMs: 30_000,
  connectionsCheckIntervalMs: 2_000,
  keepAliveTimeoutMs: 65_000,
  socketIdleTimeoutMs: 60_000,
};

export function createHttpServer(
  app: RequestListener,
  timeouts: HttpServerTimeouts = HTTP_SERVER_TIMEOUTS,
): Server {
  const server = createServer(
    {
      headersTimeout: timeouts.headersTimeoutMs,
      requestTimeout: timeouts.requestTimeoutMs,
      connectionsCheckingInterval: timeouts.connectionsCheckIntervalMs,
      keepAliveTimeout: timeouts.keepAliveTimeoutMs,
    },
    app,
  );
  server.setTimeout(timeouts.socketIdleTimeoutMs);
  return server;
}
