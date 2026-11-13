import mongoose from 'mongoose';
import { describe, expect, it, vi } from 'vitest';
import { createLogger } from '../src/config/logger.js';
import { connectWithRetry, isDatabaseConnected } from '../src/db/mongo.js';
import { createLogCapture, mockDatabaseState } from './helpers.js';

const URI = 'mongodb://user:pa55word@127.0.0.1:27017/book-tracker';

describe('isDatabaseConnected', () => {
  it('is true only in the connected state', () => {
    for (const state of Object.values(mongoose.ConnectionStates)) {
      if (typeof state !== 'number') continue;
      mockDatabaseState(state);
      expect(isDatabaseConnected()).toBe(state === mongoose.ConnectionStates.connected);
    }
  });
});

describe('connectWithRetry', () => {
  it('retries failed attempts until the connection succeeds', async () => {
    const connect = vi
      .spyOn(mongoose, 'connect')
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce(mongoose);
    const logs = createLogCapture();

    const connected = await connectWithRetry(URI, {
      logger: createLogger('warn', logs.stream),
      signal: new AbortController().signal,
      retryDelayMs: 1,
    });

    expect(connected).toBe(true);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(logs.output()).toContain('MongoDB connection attempt failed');
    expect(logs.output()).not.toContain('pa55word');
  });

  it('stops retrying once aborted', async () => {
    const controller = new AbortController();
    const connect = vi.spyOn(mongoose, 'connect').mockImplementation(() => {
      controller.abort();
      return Promise.reject(new Error('ECONNREFUSED'));
    });

    const connected = await connectWithRetry(URI, {
      logger: createLogger('silent'),
      signal: controller.signal,
      retryDelayMs: 60_000,
    });

    expect(connected).toBe(false);
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('does not attempt to connect when already aborted', async () => {
    const connect = vi.spyOn(mongoose, 'connect');

    const connected = await connectWithRetry(URI, {
      logger: createLogger('silent'),
      signal: AbortSignal.abort(),
    });

    expect(connected).toBe(false);
    expect(connect).not.toHaveBeenCalled();
  });
});
