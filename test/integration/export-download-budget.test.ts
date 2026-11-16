import { once } from 'node:events';
import { request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import mongoose from 'mongoose';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHttpServer, HTTP_SERVER_TIMEOUTS } from '../../src/http-server.js';
import { EXPORT_LIMITS } from '../../src/modules/export/export.limits.js';
import { BookModel } from '../../src/modules/books/book.model.js';
import { NoteModel } from '../../src/modules/notes/note.model.js';
import { bearer, createAuthTestApp, registerReader } from './auth-fixtures.js';
import { seedLibrary, TINY_LIBRARY } from './scale-fixtures.js';

const NOTE_CHARACTERS = 19_000;
const LARGE_NOTES = 1_600;

let server: Server;
let origin: string;
let accessToken: string;

/** A reader whose archive is close to the 32 MiB limit: 1,600 notes of 19,000 characters. */
async function seedNearlyMaximalArchive(ownerIdText: string): Promise<void> {
  await seedLibrary(ownerIdText, TINY_LIBRARY);
  const ownerId = new mongoose.Types.ObjectId(ownerIdText);
  const book = await BookModel.collection.findOne({ ownerId, deletedAt: null });
  const now = new Date();
  await NoteModel.collection.insertMany(
    Array.from({ length: LARGE_NOTES }, (_unused, position) => ({
      ownerId,
      bookId: book?._id,
      readingSessionId: null,
      kind: 'note',
      content: `Long synthetic note ${position} `.padEnd(NOTE_CHARACTERS, 'lorem ipsum '),
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
    })),
  );
}

/** Downloads the archive, optionally pausing after every few megabytes like a slow phone. */
function downloadArchive(
  pauseMsPerChunk = 0,
): Promise<{ status: number; bytes: number; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(
      `${origin}/api/v1/export/archive`,
      { headers: { authorization: bearer(accessToken) }, agent: false },
      (response) => {
        const chunks: Buffer[] = [];
        let bytesSincePause = 0;
        response.on('data', (chunk: Buffer) => {
          chunks.push(chunk);
          bytesSincePause += chunk.length;
          if (pauseMsPerChunk > 0 && bytesSincePause >= 4 * 1024 * 1024) {
            bytesSincePause = 0;
            response.pause();
            void delay(pauseMsPerChunk).then(() => response.resume());
          }
        });
        response.on('end', () => {
          const body = Buffer.concat(chunks);
          resolve({ status: response.statusCode ?? 0, bytes: body.length, body });
        });
        response.on('error', reject);
      },
    );
    outgoing.on('error', reject);
    outgoing.end();
  });
}

beforeEach(async () => {
  const app = createAuthTestApp();
  const reader = await registerReader(app);
  accessToken = reader.tokens.accessToken;
  await seedNearlyMaximalArchive(reader.user.id);
  server = createHttpServer(app, HTTP_SERVER_TIMEOUTS);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  server.closeAllConnections();
  server.close();
  await once(server, 'close');
});

describe('a near-maximum export through the production HTTP timeout policy', () => {
  it('downloads completely and parses', async () => {
    const download = await downloadArchive();

    expect(download.status).toBe(200);
    expect(download.bytes).toBeGreaterThan(28 * 1024 * 1024);
    expect(download.bytes).toBeLessThanOrEqual(EXPORT_LIMITS.maxBytes);
    const archive = JSON.parse(download.body.toString('utf8')) as { data: { notes: unknown[] } };
    expect(archive.data.notes.length).toBeGreaterThanOrEqual(LARGE_NOTES);
  });

  it('still completes for a client that pauses while reading', async () => {
    const download = await downloadArchive(250);

    expect(download.status).toBe(200);
    expect(download.bytes).toBeGreaterThan(28 * 1024 * 1024);
  });
});
