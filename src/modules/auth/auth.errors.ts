import { AppError } from '../../shared/errors.js';

export function invalidCredentialsError(): AppError {
  return new AppError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect');
}

export function invalidRefreshTokenError(): AppError {
  return new AppError(401, 'INVALID_REFRESH_TOKEN', 'Refresh token is invalid, expired or revoked');
}

export function unauthenticatedError(): AppError {
  return new AppError(401, 'UNAUTHENTICATED', 'A valid access token is required');
}

export function rateLimitedError(): AppError {
  return new AppError(429, 'RATE_LIMITED', 'Too many requests, try again later');
}
