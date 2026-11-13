import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createLogger } from '../../src/config/logger.js';
import { createLogCapture } from '../helpers.js';
import {
  bearer,
  createAuthTestApp,
  disposablePassword,
  newRegistration,
  tokensFrom,
} from './auth-fixtures.js';

describe('authentication logging', () => {
  it('never writes passwords, tokens or emails to the logs', async () => {
    const logs = createLogCapture();
    const app = createAuthTestApp({ logger: createLogger('trace', logs.stream) });
    const registration = newRegistration();
    const wrongPassword = disposablePassword();

    const registered = await request(app).post('/api/v1/auth/register').send(registration);
    const { accessToken, refreshToken } = tokensFrom(registered);
    await request(app).post('/api/v1/auth/register').send(registration);
    await request(app)
      .post('/api/v1/auth/login')
      .send({ email: registration.email, password: wrongPassword });
    const refreshed = await request(app).post('/api/v1/auth/refresh').send({ refreshToken });
    await request(app).get('/api/v1/auth/me').set('Authorization', bearer(accessToken));
    await request(app).post('/api/v1/auth/refresh').send({ refreshToken });
    await request(app)
      .post('/api/v1/auth/logout')
      .send({ refreshToken: tokensFrom(refreshed).refreshToken });

    const output = logs.output();
    expect(output).toContain('"path":"/api/v1/auth/register"');
    for (const secret of [
      registration.password,
      wrongPassword,
      registration.email,
      accessToken,
      refreshToken,
      tokensFrom(refreshed).refreshToken,
    ]) {
      expect(output).not.toContain(secret);
    }
  });
});
