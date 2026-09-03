import { z } from 'zod';

export const loginSchema = z.object({
  workspaceSlug: z.string().min(1).max(64),
  email: z.string().email(),
  password: z.string().min(1).max(200),
});
export type LoginDto = z.infer<typeof loginSchema>;

export const mfaVerifySchema = z.object({
  mfaChallenge: z.string().min(1),
  code: z.string().min(6).max(10),
});

export const refreshSchema = z.object({
  refreshToken: z.string().min(1).optional(),
});

export const stepUpSchema = z.object({ code: z.string().min(6).max(10) });

export const setPasswordSchema = z.object({
  token: z.string().min(1),
  newPassword: z.string().min(12).max(200),
});

export const mfaConfirmSchema = z.object({ code: z.string().min(6).max(10) });

export const platformLoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1).max(200),
  code: z.string().min(6).max(10).optional(),
});
