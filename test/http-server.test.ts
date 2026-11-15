import { once } from 'node:events';
import type { Server } from 'node:http';
import { connect, type AddressInfo, type Socket } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createHttpServer,
  HTTP_SERVER_TIMEOUTS,
  type HttpServerTimeouts,
} from '../src/http-server.js';

const SHORT_TIMEOUTS: HttpServerTimeouts = {
  headersTimeoutMs: 200,
  requestTimeoutMs: 400,
  connectionsCheckIntervalMs: 50,
  keepAliveTimeoutMs: 300,
  socketIdleTimeoutMs: 700,
};
const DOWNLOAD_BYTES = 32 * 1024 * 1024;

let server: Server | undefined;
let stalledDownloadClosed: Promise<{ finished: boolean }> = Promise.resolve({ finished: true });

function testApp() {
  const app = express();
  app.post('/echo', express.text(), (req, res) => {
    res.send(String(req.body));
  });
  app.get('/slow-download', async (_req, res) => {
    for (let chunk = 0; chunk < 10; chunk += 1) {
      res.write(`chunk ${chunk}\n`);
      await delay(SHORT_TIMEOUTS.socketIdleTimeoutMs / 4);
    }
    res.end();
  });
  app.get('/large-download', (_req, res) => {
    stalledDownloadClosed = new Promise((resolve) => {
      res.on('close', () => resolve({ finished: res.writableFinished }));
    });
    res.type('application/octet-stream').send(Buffer.alloc(DOWNLOAD_BYTES));
  });
  return app;
}

async function startServer(): Promise<number> {
  server = createHttpServer(testApp(), SHORT_TIMEOUTS);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return (server.address() as AddressInfo).port;
}

function openSocket(port: number): Socket {
  return connect({ port, host: '127.0.0.1' });
}

/** Everything the server sends until it closes the connection. */
async function readUntilClosed(socket: Socket): Promise<string> {
  const chunks: Buffer[] = [];
  socket.on('data', (chunk: Buffer) => chunks.push(chunk));
  await once(socket, 'close');
  return Buffer.concat(chunks).toString('utf8');
}

afterEach(async () => {
  if (server) {
    server.closeAllConnections();
    server.close();
    await once(server, 'close');
  }
  server = undefined;
});

describe('HTTP server timeouts', () => {
  it('answers 408 and closes a connection whose headers never finish (slowloris)', async () => {
    const socket = openSocket(await startServer());
    socket.write('GET /slow-download HTTP/1.1\r\nHost: localhost\r\n');

    expect(await readUntilClosed(socket)).toMatch(/^HTTP\/1\.1 408 /);
  });

  it('answers 408 and closes a connection whose body never finishes', async () => {
    const socket = openSocket(await startServer());
    socket.write(
      'POST /echo HTTP/1.1\r\nHost: localhost\r\nContent-Type: text/plain\r\nContent-Length: 10\r\n\r\nx',
    );

    expect(await readUntilClosed(socket)).toMatch(/^HTTP\/1\.1 408 /);
  });

  it('lets a valid response take longer than the request timeouts while data keeps flowing', async () => {
    const port = await startServer();

    const response = await fetch(`http://127.0.0.1:${port}/slow-download`);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body.split('\n').filter(Boolean)).toHaveLength(10);
  });

  it('delivers a 32 MiB download in full to a client that keeps reading', async () => {
    const port = await startServer();

    const response = await fetch(`http://127.0.0.1:${port}/large-download`);
    const body = await response.arrayBuffer();

    expect(body.byteLength).toBe(DOWNLOAD_BYTES);
    expect(await stalledDownloadClosed).toEqual({ finished: true });
  });

  it('destroys the connection of a client that stops reading a large download, freeing its buffer', async () => {
    const socket = openSocket(await startServer());
    socket.write('GET /large-download HTTP/1.1\r\nHost: localhost\r\n\r\n');
    socket.once('data', () => socket.pause());

    await once(socket, 'data');
    await delay(50);

    expect(await stalledDownloadClosed).toEqual({ finished: false });
    socket.destroy();
  });

  it('closes an idle keep-alive connection after the keep-alive timeout', async () => {
    const socket = openSocket(await startServer());
    socket.write(
      'POST /echo HTTP/1.1\r\nHost: localhost\r\nContent-Type: text/plain\r\nContent-Length: 2\r\n\r\nhi',
    );

    const exchange = await readUntilClosed(socket);

    expect(exchange).toMatch(/^HTTP\/1\.1 200 /);
    expect(exchange).toMatch(/\r\n\r\nhi$/);
  });
});

describe('production HTTP timeout policy', () => {
  it('gives clients less time for headers than for the whole request', () => {
    expect(HTTP_SERVER_TIMEOUTS.headersTimeoutMs).toBeLessThan(
      HTTP_SERVER_TIMEOUTS.requestTimeoutMs,
    );
  });

  it('lets the request timeout answer 408 before the idle-socket timeout silently drops a stalled upload', () => {
    expect(HTTP_SERVER_TIMEOUTS.requestTimeoutMs).toBeLessThan(
      HTTP_SERVER_TIMEOUTS.socketIdleTimeoutMs,
    );
  });

  it('keeps idle keep-alive connections longer than the 60 s proxy idle timeout documented by Railway', () => {
    expect(HTTP_SERVER_TIMEOUTS.keepAliveTimeoutMs).toBeGreaterThan(60_000);
  });

  it('enforces the request limits within a small margin of their values', () => {
    expect(HTTP_SERVER_TIMEOUTS.connectionsCheckIntervalMs).toBeLessThanOrEqual(
      HTTP_SERVER_TIMEOUTS.headersTimeoutMs / 5,
    );
  });
});
