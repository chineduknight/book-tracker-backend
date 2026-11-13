import { z } from 'zod';

export const normalizedEmailSchema = z.string().trim().toLowerCase().max(254).pipe(z.email());

export const registrationRequestSchema = z.strictObject({
  name: z.string().trim().min(1).max(100),
  email: normalizedEmailSchema,
  password: z.string().min(12).max(128),
});

export const loginRequestSchema = z.strictObject({
  email: normalizedEmailSchema,
  password: z.string().min(1).max(128),
});

export const refreshTokenRequestSchema = z.strictObject({
  refreshToken: z.string().min(1).max(256),
});

export type RegistrationRequest = z.output<typeof registrationRequestSchema>;
export type LoginRequest = z.output<typeof loginRequestSchema>;
