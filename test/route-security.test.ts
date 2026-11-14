import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createServer, request as httpRequest, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { deflateSync, gzipSync } from 'node:zlib';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { createAccessTokenService } from '../src/modules/auth/access-token.js';
import { ALLOWED_ORIGIN, createTestApp } from './helpers.js';
import {
  isWriteRoute,
  methodOf,
  pathOf,
  PRIVATE_ROUTES,
  PUBLIC_ROUTES,
  registeredRoutesOf,
  type RouteKey,
} from './route-inventory.js';

const SOME_ID = '64b7f0c2a1b2c3d4e5f60718';
const WRITE_ROUTES = PRIVATE_ROUTES.filter(isWriteRoute);

function sendTo(route: RouteKey, prepare: (pending: request.Test) => request.Test = (r) => r) {
  const method = methodOf(route).toLowerCase() as 'get' | 'post' | 'put' | 'patch' | 'delete';
  return prepare(request(createTestApp())[method](pathOf(route, () => SOME_ID)));
}

function expectUnauthenticated(res: request.Response) {
  expect(res.status).toBe(401);
  expect(res.headers['www-authenticate']).toBe('Bearer');
  expect(res.headers['cache-control']).toBe('no-store');
  expect(res.body).toEqual({
    error: {
      code: 'UNAUTHENTICATED',
      message: 'A valid access token is required',
      requestId: res.headers['x-request-id'],
    },
  });
}

describe('route inventory', () => {
  it('classifies every registered route as public or private, each exactly once', () => {
    const classified = [...PUBLIC_ROUTES, ...PRIVATE_ROUTES];

    expect(new Set(classified).size).toBe(classified.length);
    expect(registeredRoutesOf(createTestApp()).toSorted()).toEqual(classified.toSorted());
  });
});

describe('private routes without a valid access token', () => {
  it.each(PRIVATE_ROUTES)('%s refuses a request without a token', async (route) => {
    expectUnauthenticated(await sendTo(route));
  });

  it.each(PRIVATE_ROUTES)('%s refuses malformed and forged credentials', async (route) => {
    const forged = await createAccessTokenService(randomBytes(32)).issueAccessToken({
      userId: SOME_ID,
      sessionId: SOME_ID,
    });

    for (const authorization of [
      'Basic dXNlcjpwYXNz',
      'Bearer',
      'Bearer not-a-jwt',
      `Bearer  ${forged}`,
      `Token ${forged}`,
      `Bearer ${forged}`,
    ]) {
      expectUnauthenticated(await sendTo(route, (r) => r.set('Authorization', authorization)));
    }
  });
});

describe('private responses are never cacheable', () => {
  it.each(PRIVATE_ROUTES)('%s answers CORS preflight with no-store', async (route) => {
    const res = await request(createTestApp())
      .options(pathOf(route, () => SOME_ID))
      .set('Origin', ALLOWED_ORIGIN)
      .set('Access-Control-Request-Method', methodOf(route))
      .set('Access-Control-Request-Headers', 'authorization,content-type');

    expect(res.status).toBe(204);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['access-control-allow-origin']).toBe(ALLOWED_ORIGIN);
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it.each(WRITE_ROUTES)(
    '%s rejects malformed JSON with no-store before authenticating',
    async (route) => {
      const res = await sendTo(route, (r) =>
        r.set('Content-Type', 'application/json').send('{"password": "hunter2"'),
      );

      expect(res.status).toBe(400);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body.error.code).toBe('INVALID_JSON');
      expect(JSON.stringify(res.body)).not.toContain('hunter2');
    },
  );
});

describe('compressed request bodies', () => {
  const servers: Server[] = [];
  afterEach(() => servers.splice(0).forEach((server) => server.close()));

  async function postRaw(path: string, body: Buffer, contentEncoding: string) {
    const server = createServer(createTestApp());
    servers.push(server);
    server.listen(0);
    await once(server, 'listening');
    const req = httpRequest({
      port: (server.address() as AddressInfo).port,
      path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Encoding': contentEncoding,
        'Content-Length': String(body.length),
      },
    });
    req.end(body);
    const [res] = (await once(req, 'response')) as [IncomingMessage];
    let text = '';
    for await (const chunk of res) text += String(chunk);
    return { status: res.statusCode, headers: res.headers, body: JSON.parse(text) as unknown };
  }

  /* A few kilobytes that inflate to megabytes must be refused at the inflated size limit. */
  it.each([
    ['gzip', gzipSync],
    ['deflate', deflateSync],
  ] as const)('limits a %s body by its inflated size', async (encoding, compress) => {
    const bomb = compress(Buffer.from(`{"title":"${'a'.repeat(5_000_000)}"}`));
    expect(bomb.length).toBeLessThan(10_000);

    const res = await postRaw('/api/v1/books', bomb, encoding);

    expect(res.status).toBe(413);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toEqual({
      error: {
        code: 'PAYLOAD_TOO_LARGE',
        message: 'Request body exceeds the size limit',
        requestId: res.headers['x-request-id'],
      },
    });
  });
});
