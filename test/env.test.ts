import { describe, expect, it } from 'vitest';
import { ConfigError, loadEnv } from '../src/config/env.js';

const SECRET_URI = 'mongodb+srv://reader:sup3r-s3cret@cluster0.db.example.test/book-tracker';

describe('loadEnv', () => {
  it('applies defaults when only MONGODB_URI is set', () => {
    expect(loadEnv({ MONGODB_URI: 'mongodb://127.0.0.1:27017/book-tracker' })).toEqual({
      NODE_ENV: 'development',
      PORT: 3000,
      MONGODB_URI: 'mongodb://127.0.0.1:27017/book-tracker',
      CORS_ORIGIN: ['http://localhost:5173'],
      LOG_LEVEL: 'info',
    });
  });

  it('parses explicit values and comma-separated CORS origins', () => {
    const env = loadEnv({
      NODE_ENV: 'production',
      PORT: '8080',
      MONGODB_URI: SECRET_URI,
      CORS_ORIGIN: 'https://books.example.com, http://localhost:5173',
      LOG_LEVEL: 'warn',
    });

    expect(env.PORT).toBe(8080);
    expect(env.CORS_ORIGIN).toEqual(['https://books.example.com', 'http://localhost:5173']);
  });

  it('requires MONGODB_URI', () => {
    expect(() => loadEnv({})).toThrow(/MONGODB_URI: is required/);
  });

  it.each(['*', 'https://*.example.com', 'http://localhost:5173/', 'localhost:5173', ' , '])(
    'rejects CORS_ORIGIN=%j',
    (value) => {
      expect(() => loadEnv({ MONGODB_URI: SECRET_URI, CORS_ORIGIN: value })).toThrow(ConfigError);
    },
  );

  it.each([
    ['PORT', 'not-a-port'],
    ['PORT', '70000'],
    ['NODE_ENV', 'staging'],
    ['LOG_LEVEL', 'verbose'],
  ])('rejects %s=%s', (name, value) => {
    expect(() => loadEnv({ MONGODB_URI: SECRET_URI, [name]: value })).toThrow(
      new RegExp(`- ${name}:`),
    );
  });

  it('never includes variable values in error messages', () => {
    const attempt = () =>
      loadEnv({ MONGODB_URI: 'postgres://reader:sup3r-s3cret@db', PORT: 'sup3r-s3cret' });

    expect(attempt).toThrow(ConfigError);
    expect(attempt).toThrow(/MONGODB_URI: must start with mongodb:\/\//);
    try {
      attempt();
    } catch (error) {
      expect((error as Error).message).not.toContain('sup3r-s3cret');
    }
  });
});
