import mongoose from 'mongoose';
import { describe, expect, it, vi } from 'vitest';
import { createLogger } from '../src/config/logger.js';
import {
  connectWithRetry,
  isDatabaseConnected,
  registerDatabaseEventLogging,
} from '../src/db/mongo.js';
import {
  createCredentialError,
  createLogCapture,
  CREDENTIAL_URI as URI,
  expectNoCredentials,
  mockDatabaseState,
} from './helpers.js';

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
      .mockRejectedValueOnce(createCredentialError())
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
    expect(logs.output()).toContain('"err":{"name":"Error","code":"ECONNREFUSED"}');
    expectNoCredentials(logs.output());
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

describe('registerDatabaseEventLogging', () => {
  it('logs connection errors without credentials', () => {
    const { connection } = mongoose;
    const events = ['connected', 'disconnected', 'reconnected', 'error'];
    const before = new Map(events.map((event) => [event, new Set(connection.listeners(event))]));
    const logs = createLogCapture();
    registerDatabaseEventLogging(createLogger('info', logs.stream));

    try {
      connection.emit('error', createCredentialError());
    } finally {
      // Remove only the listeners this test added to the shared default connection.
      for (const event of events) {
        for (const listener of connection.listeners(event) as ((...args: unknown[]) => void)[]) {
          if (!before.get(event)?.has(listener)) connection.off(event, listener);
        }
      }
    }

    expect(logs.output()).toContain('MongoDB connection error');
    expect(logs.output()).toContain('"err":{"name":"Error","code":"ECONNREFUSED"}');
    expectNoCredentials(logs.output());
  });
});
