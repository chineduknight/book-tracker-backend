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
      TRUST_PROXY_HOPS: 0,
    });
  });

  it('parses explicit values and comma-separated CORS origins', () => {
    const env = loadEnv({
      NODE_ENV: 'production',
      PORT: '8080',
      ...requiredEnv,
      CORS_ORIGIN: 'https://books.example.com, https://www.books.example.com',
      LOG_LEVEL: 'warn',
      TRUST_PROXY_HOPS: '1',
      READER_REQUESTS_PER_MINUTE: '300',
    });

    expect(env.PORT).toBe(8080);
    expect(env.CORS_ORIGIN).toEqual(['https://books.example.com', 'https://www.books.example.com']);
    expect(env.TRUST_PROXY_HOPS).toBe(1);
    expect(env.READER_REQUESTS_PER_MINUTE).toBe(300);
  });

  it('leaves the per-reader request limit off unless it is configured', () => {
    expect(loadEnv(requiredEnv).READER_REQUESTS_PER_MINUTE).toBeUndefined();
  });

  it.each(['true', 'false', 'yes', '', ' 1', '1.5', '-1', '01', '4', 'loopback', '10.0.0.0/8'])(
    'rejects TRUST_PROXY_HOPS=%j: only a small explicit hop count is accepted',
    (value) => {
      expect(() => loadEnv({ ...requiredEnv, TRUST_PROXY_HOPS: value })).toThrow(
        /- TRUST_PROXY_HOPS:/,
      );
    },
  );

  it.each(['0', '', 'unlimited', '10001', '2.5'])(
    'rejects READER_REQUESTS_PER_MINUTE=%j',
    (value) => {
      expect(() => loadEnv({ ...requiredEnv, READER_REQUESTS_PER_MINUTE: value })).toThrow(
        /- READER_REQUESTS_PER_MINUTE:/,
      );
    },
  );

  it('accepts local http origins outside production', () => {
    expect(loadEnv({ ...requiredEnv, CORS_ORIGIN: 'http://localhost:5173' }).CORS_ORIGIN).toEqual([
      'http://localhost:5173',
    ]);
  });

  describe('in production', () => {
    const production = {
      ...requiredEnv,
      NODE_ENV: 'production',
      CORS_ORIGIN: 'https://books.example.com',
    };

    it('accepts an exact https origin list', () => {
      expect(loadEnv(production).CORS_ORIGIN).toEqual(['https://books.example.com']);
    });

    it.each(['http://localhost:5173', 'https://books.example.com,http://books.example.com'])(
      'refuses the non-https CORS_ORIGIN %j',
      (value) => {
        expect(() => loadEnv({ ...production, CORS_ORIGIN: value })).toThrow(
          /- CORS_ORIGIN: must list only https:\/\/ origins in production/,
        );
      },
    );

    it('refuses the default development origin when CORS_ORIGIN is unset', () => {
      expect(() => loadEnv({ ...production, CORS_ORIGIN: undefined })).toThrow(/- CORS_ORIGIN:/);
    });

    it.each(['MONGODB_TEST_URI', 'MONGODB_SMOKE_URI', 'RESTORE_REHEARSAL_URI'])(
      'refuses to start while the destructive tooling variable %s is set, without echoing it',
      (variable) => {
        const attempt = () => loadEnv({ ...production, [variable]: SECRET_URI });

        expect(attempt).toThrow(new RegExp(`- ${variable}: must not be set in production`));
        try {
          attempt();
        } catch (error) {
          expect((error as Error).message).not.toContain('sup3r-s3cret');
        }
      },
    );

    it('still refuses a weak signing secret', () => {
      expect(() => loadEnv({ ...production, JWT_ACCESS_TOKEN_SECRET: 'a'.repeat(64) })).toThrow(
        /must be randomly generated/,
      );
    });
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
