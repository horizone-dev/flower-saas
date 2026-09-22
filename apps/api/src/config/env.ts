import { z } from 'zod';
import { backendEnvSchema } from '@flower/backend';

/**
 * Environment contract for `apps/api`. Parsed once at boot; a missing or
 * malformed value fails fast with a readable error (never a silent default in a
 * money/security path).
 *
 * The shared **infrastructure** fields (NODE_ENV, LOG_LEVEL, DATABASE_URL,
 * PLATFORM_DATABASE_URL) are defined **once** in `@flower/backend`
 * (`backendEnvSchema`) and reused by `apps/worker` / `apps/scheduler` — the three
 * runtimes can never drift. This schema `.extend()`s that set with every field
 * that is API-only (HTTP, auth, CORS, secrets, idempotency, the readiness-probe
 * infra endpoints).
 */
const envSchema = backendEnvSchema.extend({
  API_PORT: z.coerce.number().int().positive().default(3001),
  API_HOST: z.string().default('0.0.0.0'),

  // Infra endpoints — used by the readiness probes (real drivers arrive in later phases).
  POSTGRES_HOST: z.string().default('localhost'),
  POSTGRES_PORT: z.coerce.number().int().positive().default(5432),
  REDIS_HOST: z.string().default('localhost'),
  REDIS_PORT: z.coerce.number().int().positive().default(6379),
  REDIS_URL: z.string().optional(),
  S3_ENDPOINT: z.string().url().default('http://localhost:9000'),

  // Idempotency store (task 2.2 — an API request-path concern). TTL: how long a
  // stored result stays replayable. STALE_LOCK: after this long a crashed PENDING
  // key is reclaimable. MAX_SNAPSHOT_BYTES: a larger 2xx body is not cached.
  // WAIT_MS: how long a concurrent identical request waits for the owner.
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
  IDEMPOTENCY_WAIT_MS: z.coerce.number().int().positive().default(5000),

  // Auth (task 1.4/1.5). AUTH_JWT_SECRET / AUTH_ACCESS_TOKEN_TTL_SECONDS moved to
  // `backendEnvSchema` (task 2.5) — `JwtService` now lives in `@flower/backend`
  // and every process that verifies a token (not just the one that signs it)
  // needs the secret; inherited here via `.extend()`, not redeclared, so there
  // is exactly one definition. A real secret is required in production (checked
  // below, an apps/api-only check — it is the only signer, so the only process
  // that can be unsafely misconfigured this way).
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

  // Task 3b.5 Checkpoint F/G — `WebhookRecoveryProcessor`'s tick loop
  // (owner reliability-pass §15: "bounded batch size, bounded polling
  // interval... use repository configuration conventions"). Not a
  // user-facing setting — an operational tuning knob, same convention as
  // `IDEMPOTENCY_*`/`AUTH_*` above.
  //
  // Checkpoint G final security/operational pass — `apps/worker`'s
  // `OutboxDispatcher` (the one directly comparable periodic-poll precedent
  // in this repo) never exposes its own interval/batch as env vars at all —
  // they are hardcoded module constants (`tickIntervalMs: 500`,
  // `tenantBatchSize: 10`, `publishBatchSize: 20`, `seq-allocator.ts`/
  // `publisher.ts`/`dispatcher.ts`'s own `DEFAULTS`). `env.ts` itself has no
  // existing `.max(...)` convention anywhere to mirror (inspected the whole
  // file — every other numeric field is `.int().positive()` only). This is
  // therefore the first user-configurable poll-loop knob in the repo, and
  // the first to need an explicit ceiling, not merely a floor:
  //   - MIN 1000ms — anything smaller risks an accidental tight loop
  //     hammering the DB with a full cross-tenant SELECT every tick; a full
  //     order of magnitude above `OutboxDispatcher`'s own hardcoded 500ms
  //     floor, since THIS query and its per-candidate transactions are
  //     materially heavier than that dispatcher's own tick.
  //   - MAX 300_000ms (5 minutes) — a defensive ceiling; far beyond this
  //     and a misconfigured recovery loop stops being an effective
  //     liveness guarantee at all (owner §F1/§2's own stated purpose).
  //   - batch size MIN 1 (already implied by `.positive()`), MAX 500 — an
  //     order of magnitude above `OutboxDispatcher`'s own largest hardcoded
  //     batch (50), generous for real operational need while keeping a
  //     single tick's per-candidate transaction count, and therefore its
  //     worst-case DB/memory pressure, finite and bounded by construction.
  WEBHOOK_RECOVERY_TICK_INTERVAL_MS: z.coerce.number().int().min(1000).max(300_000).default(30_000),
  WEBHOOK_RECOVERY_BATCH_SIZE: z.coerce.number().int().min(1).max(500).default(20),
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
