import { isDuplicateKeyError } from '../../db/mongo.js';
import { AppError } from '../../shared/errors.js';
import { toPublicUser, type UserDto } from './user.dto.js';
import { UserModel } from './user.model.js';

export interface NewUser {
  name: string;
  email: string;
  passwordHash: string;
}

export interface UserCredentials {
  user: UserDto;
  passwordHash: string;
}

export async function createUser(newUser: NewUser): Promise<UserDto> {
  try {
    const user = await UserModel.create(newUser);
    return toPublicUser(user);
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      throw new AppError(409, 'CONFLICT', 'An account with this email already exists');
    }
    throw error;
  }
}

export async function findUserCredentialsByNormalizedEmail(
  email: string,
): Promise<UserCredentials | null> {
  const user = await UserModel.findOne({ email }).select('+passwordHash').lean();
  if (!user) return null;
  return { user: toPublicUser(user), passwordHash: user.passwordHash };
}

export async function findUserById(userId: string): Promise<UserDto | null> {
  const user = await UserModel.findById(userId).lean();
  return user ? toPublicUser(user) : null;
}
