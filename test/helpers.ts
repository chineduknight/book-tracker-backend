import { Writable } from 'node:stream';
import mongoose from 'mongoose';
import { vi } from 'vitest';
import { createApp } from '../src/app.js';
import { createLogger } from '../src/config/logger.js';

export const ALLOWED_ORIGIN = 'http://localhost:5173';

/** Collects log lines written by a logger so tests can inspect them. */
export function createLogCapture() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      lines.push(chunk.toString());
      callback();
    },
  });
  return { stream, output: () => lines.join('') };
}

export function createTestApp() {
  const logger = createLogger('silent');
  return createApp({ logger, corsOrigins: [ALLOWED_ORIGIN] });
}

/** Simulate the default Mongoose connection being in a given state without a real database. */
export function mockDatabaseState(state: mongoose.ConnectionStates): void {
  vi.spyOn(mongoose.connection, 'readyState', 'get').mockReturnValue(state);
}
