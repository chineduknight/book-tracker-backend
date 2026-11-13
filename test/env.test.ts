import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadEnv } from '../src/config/env.js';

const SECRET_URI = 'mongodb+srv://reader:sup3r-s3cret@cluster0.db.example.test/book-tracker';
const ACCESS_TOKEN_SECRET_BYTES = randomBytes(32);
const ACCESS_TOKEN_SECRET = ACCESS_TOKEN_SECRET_BYTES.toString('base64url');
const requiredEnv = { MONGODB_URI: SECRET_URI, JWT_ACCESS_TOKEN_SECRET: ACCESS_TOKEN_SECRET };

describe('loadEnv', () => {
  it('applies defaults when only the required variables are set', () => {
    expect(loadEnv(requiredEnv)).toEqual({
      NODE_ENV: 'development',
      PORT: 3000,
      MONGODB_URI: SECRET_URI,
      CORS_ORIGIN: ['http://localhost:5173'],
      LOG_LEVEL: 'info',
      JWT_ACCESS_TOKEN_SECRET: ACCESS_TOKEN_SECRET_BYTES,
    });
  });

  it('parses explicit values and comma-separated CORS origins', () => {
    const env = loadEnv({
      NODE_ENV: 'production',
      PORT: '8080',
      ...requiredEnv,
      CORS_ORIGIN: 'https://books.example.com, http://localhost:5173',
      LOG_LEVEL: 'warn',
    });

    expect(env.PORT).toBe(8080);
    expect(env.CORS_ORIGIN).toEqual(['https://books.example.com', 'http://localhost:5173']);
  });

  it.each(['MONGODB_URI', 'JWT_ACCESS_TOKEN_SECRET'])('requires %s', (name) => {
    expect(() => loadEnv({ ...requiredEnv, [name]: undefined })).toThrow(
      new RegExp(`${name}: is required`),
    );
  });

  it.each([
    ['too short', randomBytes(16).toString('base64url'), /at least 32 bytes/],
    ['not base64url', `${ACCESS_TOKEN_SECRET}+/=`, /must be base64url-encoded/],
    ['a repeated placeholder', 'a'.repeat(64), /must be randomly generated/],
  ])('rejects a JWT_ACCESS_TOKEN_SECRET that is %s without echoing it', (_label, secret, rule) => {
    const attempt = () => loadEnv({ ...requiredEnv, JWT_ACCESS_TOKEN_SECRET: secret });

    expect(attempt).toThrow(rule);
    try {
      attempt();
    } catch (error) {
      expect((error as Error).message).not.toContain(secret);
    }
  });

  it.each(['*', 'https://*.example.com', 'http://localhost:5173/', 'localhost:5173', ' , '])(
    'rejects CORS_ORIGIN=%j',
    (value) => {
      expect(() => loadEnv({ ...requiredEnv, CORS_ORIGIN: value })).toThrow(ConfigError);
    },
  );

  it.each([
    ['PORT', 'not-a-port'],
    ['PORT', '70000'],
    ['NODE_ENV', 'staging'],
    ['LOG_LEVEL', 'verbose'],
  ])('rejects %s=%s', (name, value) => {
    expect(() => loadEnv({ ...requiredEnv, [name]: value })).toThrow(new RegExp(`- ${name}:`));
  });

  it('never includes variable values in error messages', () => {
    const attempt = () =>
      loadEnv({
        ...requiredEnv,
        MONGODB_URI: 'postgres://reader:sup3r-s3cret@db',
        PORT: 'sup3r-s3cret',
      });

    expect(attempt).toThrow(ConfigError);
    expect(attempt).toThrow(/MONGODB_URI: must start with mongodb:\/\//);
    try {
      attempt();
    } catch (error) {
      expect((error as Error).message).not.toContain('sup3r-s3cret');
    }
  });
});
