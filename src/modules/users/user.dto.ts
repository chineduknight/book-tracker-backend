import type { UserRecord } from './user.model.js';

export interface UserDto {
  id: string;
  name: string;
  email: string;
  createdAt: string;
}

export function toPublicUser(
  user: Pick<UserRecord, '_id' | 'name' | 'email' | 'createdAt'>,
): UserDto {
  return {
    id: user._id.toHexString(),
    name: user.name,
    email: user.email,
    createdAt: user.createdAt.toISOString(),
  };
}
