import type { SuccessResponseBody } from '../../shared/api-response.js';
import type { UserDto } from '../users/user.dto.js';

export interface SessionTokensDto {
  accessToken: string;
  refreshToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
  refreshExpiresIn: number;
}

export interface AuthenticatedSessionDto {
  user: UserDto;
  tokens: SessionTokensDto;
}

export type AuthenticatedSessionResponseBody = SuccessResponseBody<AuthenticatedSessionDto>;
export type RefreshedSessionResponseBody = SuccessResponseBody<{ tokens: SessionTokensDto }>;
export type CurrentUserResponseBody = SuccessResponseBody<{ user: UserDto }>;
