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

  // Idempotency store (Phase 2-core task 2.2). Opt-in per route via `@Idempotent`.
  // TTL: how long a stored result stays replayable. STALE_LOCK: after this long a
  // crashed PENDING key is reclaimable. MAX_SNAPSHOT_BYTES: a larger 2xx body is
  // not cached (the key still transitions to DONE; a replay says so).
  IDEMPOTENCY_TTL_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(60 * 60 * 24),
  IDEMPOTENCY_STALE_LOCK_SECONDS: z.coerce.number().int().positive().default(120),
  IDEMPOTENCY_MAX_SNAPSHOT_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(64 * 1024),

  // Browser origins allowed to call the API (the POS PWA — Bearer for protected
  // calls, plus the HttpOnly refresh cookie on `/v1/auth/*`). Comma separated,
  // exact match, never `*`. Empty → CORS disabled. Production MUST set real
  // origins (the localhost defaults are refused when NODE_ENV=production).
  CORS_ORIGINS: z.string().default('http://localhost:3200,http://localhost:3300'),

  // Secrets vault (task 1.10). `dev` = AES-256-GCM with a per-tenant DEK wrapped
  // by an env master key — acceptable for local dev + CI ONLY (OD4). Production
  // onboarding is gated on a managed provider (`kms`) — the `dev` provider is
  // refused when NODE_ENV=production (G16). `SECRETS_MASTER_KEY` is any passphrase
  // ≥ 32 chars; the 32-byte key is derived from it.
  SECRETS_PROVIDER: z.enum(['dev', 'kms']).default('dev'),
  SECRETS_MASTER_KEY: z
    .string()
    .min(32)
    .default('dev-only-insecure-secrets-master-key-change-me-000'),
});

export type AppConfig = Readonly<z.infer<typeof envSchema>>;

export class EnvValidationError extends Error {
  constructor(issues: string) {
    super(`Invalid environment:\n${issues}`);
    this.name = 'EnvValidationError';
  }
}

const DEV_JWT_SECRET = 'dev-only-insecure-jwt-secret-change-me-000';
const DEV_SECRETS_MASTER_KEY = 'dev-only-insecure-secrets-master-key-change-me-000';

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
    // G16 — the env-master-key vault is a dev/CI convenience only. Production
    // tenant onboarding must run against a managed provider (OD4 / §4).
    if (cfg.SECRETS_PROVIDER === 'dev') {
      throw new EnvValidationError(
        '  - SECRETS_PROVIDER: the "dev" secrets provider must not be used in production (set SECRETS_PROVIDER=kms)',
      );
    }
    if (cfg.SECRETS_MASTER_KEY === DEV_SECRETS_MASTER_KEY) {
      throw new EnvValidationError(
        '  - SECRETS_MASTER_KEY: the dev default must not be used in production',
      );
    }
    // credentialed CORS with a localhost / wildcard origin is a real risk — the
    // browser refuses `*` with credentials, and a stray localhost entry would
    // trust a dev machine on the network. Force explicit production origins.
    const origins = cfg.CORS_ORIGINS.split(',').map((o) => o.trim());
    if (origins.some((o) => o === '*' || /^https?:\/\/localhost(:\d+)?$/i.test(o))) {
      throw new EnvValidationError(
        '  - CORS_ORIGINS: set explicit production origins (no "*" or localhost)',
      );
    }
  }
  return Object.freeze(cfg);
}

/** DI token for the validated config. */
export const APP_CONFIG = Symbol('APP_CONFIG');
