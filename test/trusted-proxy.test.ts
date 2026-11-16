import { once } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createHttpServer } from '../src/http-server.js';
import { DEFAULT_AUTH_RATE_LIMITS } from '../src/modules/auth/auth.rate-limits.js';
import { createTestApp } from './helpers.js';
import { startForwardingProxy, type ForwardingProxy } from './support/forwarding-proxy.js';
import { sendRequest } from './support/http-client.js';

const AUTH_REQUESTS_PER_IP = 50;
const LOGIN_PATH = '/api/v1/auth/login';

/** Headers a caller might forge to pose as another client. */
const FORGED_IDENTITIES = [
  { 'x-forwarded-for': '203.0.113.10' },
  { 'x-forwarded-for': '198.51.100.20, 203.0.113.11' },
  { forwarded: 'for=203.0.113.12', 'x-real-ip': '203.0.113.13' },
];

let api: Server | undefined;
let proxy: ForwardingProxy | undefined;

async function startApiTrusting(trustProxyHops: number): Promise<number> {
  api = createHttpServer(
    createTestApp({
      trustProxyHops,
      authRateLimits: {
        ...DEFAULT_AUTH_RATE_LIMITS,
        authRequestsPerIp: { limit: AUTH_REQUESTS_PER_IP, windowMs: 60_000 },
        failedLoginsPerIp: { limit: 1_000, windowMs: 60_000 },
      },
    }),
  );
  api.listen(0, '127.0.0.1');
  await once(api, 'listening');
  return (api.address() as AddressInfo).port;
}

async function startProxiedApi(trustProxyHops: number): Promise<ForwardingProxy> {
  proxy = await startForwardingProxy(await startApiTrusting(trustProxyHops));
  return proxy;
}

/** Requests left in the caller's auth bucket, from the standard RateLimit response header. */
async function remainingAfterLogin(origin: string, headers: Record<string, string> = {}) {
  const response = await sendRequest(`${origin}${LOGIN_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: '{}',
  });
  expect(response.status).toBe(400);
  const remaining = /\br=(\d+)/.exec(String(response.headers.ratelimit))?.[1];
  return Number(remaining);
}

afterEach(async () => {
  await proxy?.close();
  if (api) {
    api.closeAllConnections();
    api.close();
    await once(api, 'close');
  }
  proxy = undefined;
  api = undefined;
});

describe('client identity behind one appending proxy', () => {
  it('with TRUST_PROXY_HOPS=1, forged forwarding headers never move a client to another bucket', async () => {
    const { ipv4Origin, ipv6Origin } = await startProxiedApi(1);

    const remainingForClientA = [];
    for (const forged of FORGED_IDENTITIES) {
      remainingForClientA.push(await remainingAfterLogin(ipv4Origin, forged));
    }
    const firstForClientB = await remainingAfterLogin(ipv6Origin, FORGED_IDENTITIES[0]);

    expect(remainingForClientA).toEqual([
      AUTH_REQUESTS_PER_IP - 1,
      AUTH_REQUESTS_PER_IP - 2,
      AUTH_REQUESTS_PER_IP - 3,
    ]);
    expect(firstForClientB).toBe(AUTH_REQUESTS_PER_IP - 1);
  });

  it('with TRUST_PROXY_HOPS=1, a client that exhausts its limit cannot escape it, and others are unaffected', async () => {
    const { ipv4Origin, ipv6Origin } = await startProxiedApi(1);
    for (let request = 0; request < AUTH_REQUESTS_PER_IP; request += 1) {
      await remainingAfterLogin(ipv4Origin);
    }

    const blocked = await sendRequest(`${ipv4Origin}${LOGIN_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.99' },
      body: '{}',
    });

    expect(blocked.status).toBe(429);
    expect(blocked.headers['retry-after']).toBeDefined();
    expect(blocked.headers['cache-control']).toBe('no-store');
    expect(await remainingAfterLogin(ipv6Origin)).toBe(AUTH_REQUESTS_PER_IP - 1);
  });

  it('with TRUST_PROXY_HOPS=0 (the default), every proxied client shares the proxy address bucket', async () => {
    const { ipv4Origin, ipv6Origin } = await startProxiedApi(0);

    await remainingAfterLogin(ipv4Origin, FORGED_IDENTITIES[0]);
    const forClientB = await remainingAfterLogin(ipv6Origin);

    expect(forClientB).toBe(AUTH_REQUESTS_PER_IP - 2);
  });

  it('with more hops trusted than exist, a forged X-Forwarded-For chooses the bucket (why the count must be exact)', async () => {
    const { ipv4Origin } = await startProxiedApi(2);

    const first = await remainingAfterLogin(ipv4Origin, { 'x-forwarded-for': '203.0.113.1' });
    const second = await remainingAfterLogin(ipv4Origin, { 'x-forwarded-for': '203.0.113.2' });

    expect([first, second]).toEqual([AUTH_REQUESTS_PER_IP - 1, AUTH_REQUESTS_PER_IP - 1]);
  });

  it('with TRUST_PROXY_HOPS=1, a client that bypasses the proxy can forge its address (why the API must be reachable only through it)', async () => {
    const apiOrigin = `http://127.0.0.1:${await startApiTrusting(1)}`;

    const first = await remainingAfterLogin(apiOrigin, { 'x-forwarded-for': '203.0.113.1' });
    const second = await remainingAfterLogin(apiOrigin, { 'x-forwarded-for': '203.0.113.2' });

    expect([first, second]).toEqual([AUTH_REQUESTS_PER_IP - 1, AUTH_REQUESTS_PER_IP - 1]);
  });

  it('without a proxy and with the default TRUST_PROXY_HOPS=0, forged headers are ignored', async () => {
    const apiOrigin = `http://127.0.0.1:${await startApiTrusting(0)}`;

    const first = await remainingAfterLogin(apiOrigin, { 'x-forwarded-for': '203.0.113.1' });
    const second = await remainingAfterLogin(apiOrigin, { 'x-forwarded-for': '203.0.113.2' });

    expect([first, second]).toEqual([AUTH_REQUESTS_PER_IP - 1, AUTH_REQUESTS_PER_IP - 2]);
  });
});
