import { z } from 'zod';

/**
 * Environment contract for `apps/api`. Parsed once at boot; a missing or
 * malformed value fails fast with a readable error (never a silent default in a
 * money/security path).
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  API_PORT: z.coerce.number().int().positive().default(3001),
  API_HOST: z.string().default('0.0.0.0'),

  // Infra endpoints — used by the readiness probes (real drivers arrive in later phases).
  POSTGRES_HOST: z.string().default('localhost'),
  POSTGRES_PORT: z.coerce.number().int().positive().default(5432),
  REDIS_HOST: z.string().default('localhost'),
  REDIS_PORT: z.coerce.number().int().positive().default(6379),
  S3_ENDPOINT: z.string().url().default('http://localhost:9000'),

  // Postgres. `DATABASE_URL` is the app connection (scoped queries drop to
  // `flower_app`); `PLATFORM_DATABASE_URL` is the separate audited platform path
  // (`flower_platform`, BYPASSRLS — ADR-0014). In dev they can be the same URL.
  DATABASE_URL: z.string().optional(),
  PLATFORM_DATABASE_URL: z.string().optional(),
  REDIS_URL: z.string().optional(),

  // Auth (task 1.4/1.5). A dev default keeps unit tests self-contained; a real
  // secret is required in production (checked at bootstrap).
  AUTH_JWT_SECRET: z.string().min(32).default('dev-only-insecure-jwt-secret-change-me-000'),
  AUTH_ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(600),
  AUTH_REFRESH_TOKEN_TTL_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(60 * 60 * 24 * 30),
  AUTH_STEP_UP_TTL_SECONDS: z.coerce.number().int().positive().default(300),
  AUTH_SESSION_TTL_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(60 * 60 * 12),
  AUTH_LOGIN_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  AUTH_LOGIN_LOCKOUT_SECONDS: z.coerce.number().int().positive().default(900),
});

export type AppConfig = Readonly<z.infer<typeof envSchema>>;

export class EnvValidationError extends Error {
  constructor(issues: string) {
    super(`Invalid environment:\n${issues}`);
    this.name = 'EnvValidationError';
  }
}

const DEV_JWT_SECRET = 'dev-only-insecure-jwt-secret-change-me-000';

export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new EnvValidationError(issues);
  }
  const cfg = parsed.data;
  if (cfg.NODE_ENV === 'production') {
    if (cfg.AUTH_JWT_SECRET === DEV_JWT_SECRET) {
      throw new EnvValidationError(
        '  - AUTH_JWT_SECRET: the dev default must not be used in production',
      );
    }
    if (!cfg.DATABASE_URL) {
      throw new EnvValidationError('  - DATABASE_URL: required in production');
    }
  }
  return Object.freeze(cfg);
}

/** DI token for the validated config. */
export const APP_CONFIG = Symbol('APP_CONFIG');
