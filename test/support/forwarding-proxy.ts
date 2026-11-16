import { once } from 'node:events';
import { createServer, request, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A minimal reverse proxy that behaves like a hosting edge: it forwards every request to the
 * upstream API and appends the TCP peer it observed to X-Forwarded-For, keeping whatever the
 * client sent before it. It listens on IPv4 and IPv6 loopback separately, so two clients reach it
 * from two distinct addresses (127.0.0.1 and ::1) on any machine.
 */
export interface ForwardingProxy {
  ipv4Origin: string;
  ipv6Origin: string;
  close(): Promise<void>;
}

function forwardedForChain(req: IncomingMessage): string {
  const observedPeer = req.socket.remoteAddress ?? 'unknown';
  const sentByClient = req.headers['x-forwarded-for'];
  return sentByClient ? `${String(sentByClient)}, ${observedPeer}` : observedPeer;
}

function createProxyServer(upstreamPort: number): Server {
  return createServer((req, res) => {
    const upstream = request(
      {
        host: '127.0.0.1',
        port: upstreamPort,
        method: req.method,
        path: req.url,
        headers: { ...req.headers, 'x-forwarded-for': forwardedForChain(req) },
      },
      (upstreamResponse) => {
        res.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
        upstreamResponse.pipe(res);
      },
    );
    upstream.on('error', () => res.writeHead(502).end());
    req.pipe(upstream);
  });
}

async function listen(server: Server, host: string): Promise<number> {
  server.listen({ host, port: 0, ipv6Only: host === '::1' });
  await once(server, 'listening');
  return (server.address() as AddressInfo).port;
}

export async function startForwardingProxy(upstreamPort: number): Promise<ForwardingProxy> {
  const ipv4 = createProxyServer(upstreamPort);
  const ipv6 = createProxyServer(upstreamPort);
  const [ipv4Port, ipv6Port] = await Promise.all([listen(ipv4, '127.0.0.1'), listen(ipv6, '::1')]);
  return {
    ipv4Origin: `http://127.0.0.1:${ipv4Port}`,
    ipv6Origin: `http://[::1]:${ipv6Port}`,
    close: async () => {
      for (const server of [ipv4, ipv6]) {
        server.closeAllConnections();
        server.close();
      }
      await Promise.all([once(ipv4, 'close'), once(ipv6, 'close')]);
    },
  };
}
