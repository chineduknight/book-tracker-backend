import request from 'supertest';
import { describe, expect, it } from 'vitest';
import {
  bearer,
  createAuthTestApp,
  newRegistration,
  registerReader,
  tokensFrom,
} from './auth-fixtures.js';
import { ALLOWED_ORIGIN } from '../helpers.js';

const READER_LIMIT = 5;

function appWithReaderLimit(readerRequestsPerMinute: number | undefined = READER_LIMIT) {
  return createAuthTestApp({ readerRequestsPerMinute });
}

describe('per-reader request throttling', () => {
  it('is off by default: a reader is not throttled beyond the authentication limits', async () => {
    const app = createAuthTestApp();
    const { tokens } = await registerReader(app);

    for (let attempt = 0; attempt < READER_LIMIT * 4; attempt += 1) {
      const res = await request(app)
        .get('/api/v1/books')
        .set('Authorization', bearer(tokens.accessToken));
      expect(res.status).toBe(200);
    }
  });

  it('answers 429 with Retry-After, no-store and the standard envelope once a reader exceeds the limit', async () => {
    const app = appWithReaderLimit();
    const { tokens } = await registerReader(app);
    const auth = bearer(tokens.accessToken);

    for (let attempt = 0; attempt < READER_LIMIT; attempt += 1) {
      expect((await request(app).get('/api/v1/books').set('Authorization', auth)).status).toBe(200);
    }
    const blocked = await request(app).get('/api/v1/dashboard/summary').set('Authorization', auth);

    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    expect(blocked.headers['cache-control']).toBe('no-store');
    expect(blocked.body).toEqual({
      error: {
        code: 'RATE_LIMITED',
        message: 'Too many requests, try again later',
        requestId: blocked.headers['x-request-id'],
      },
    });
  });

  it('counts each reader separately, so one busy reader never throttles another', async () => {
    const app = appWithReaderLimit();
    const busy = await registerReader(app);
    const other = await registerReader(app);

    for (let attempt = 0; attempt <= READER_LIMIT; attempt += 1) {
      await request(app).get('/api/v1/books').set('Authorization', bearer(busy.tokens.accessToken));
    }
    const otherResponse = await request(app)
      .get('/api/v1/books')
      .set('Authorization', bearer(other.tokens.accessToken));

    expect(otherResponse.status).toBe(200);
    expect(otherResponse.body).toEqual({
      data: [],
      meta: { pagination: { page: 1, limit: 20, total: 0, totalPages: 0 } },
    });
  });

  it('counts the reader across sessions and devices, not per access token', async () => {
    const app = appWithReaderLimit();
    const registration = newRegistration();
    const firstDevice = await registerReader(app, registration);
    for (let attempt = 0; attempt < READER_LIMIT; attempt += 1) {
      await request(app)
        .get('/api/v1/books')
        .set('Authorization', bearer(firstDevice.tokens.accessToken));
    }

    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: registration.email, password: registration.password });
    expect(login.status).toBe(200);
    const secondDevice = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', bearer(tokensFrom(login).accessToken));

    expect(secondDevice.status).toBe(429);
  });

  it('does not count requests that fail authentication, nor probes and preflights', async () => {
    const app = appWithReaderLimit(1);
    const { tokens } = await registerReader(app);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await request(app).get('/api/v1/books')).status).toBe(401);
      expect((await request(app).get('/api/v1/health')).status).toBe(200);
      expect((await request(app).get('/api/v1/ready')).status).toBe(200);
      const preflight = await request(app)
        .options('/api/v1/books')
        .set('Origin', ALLOWED_ORIGIN)
        .set('Access-Control-Request-Method', 'GET');
      expect(preflight.status).toBe(204);
    }
    const firstAuthenticated = await request(app)
      .get('/api/v1/books')
      .set('Authorization', bearer(tokens.accessToken));

    expect(firstAuthenticated.status).toBe(200);
  });

  it('lets a normal burst of concurrent requests through under the configured ceiling', async () => {
    const app = appWithReaderLimit(300);
    const { tokens } = await registerReader(app);
    const auth = bearer(tokens.accessToken);

    const burst = await Promise.all(
      Array.from({ length: 40 }, () =>
        request(app).get('/api/v1/books').set('Authorization', auth),
      ),
    );

    expect(burst.map((res) => res.status)).toEqual(Array.from({ length: 40 }, () => 200));
  });
});
