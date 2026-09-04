import { z } from 'zod';

/**
 * The **infrastructure** environment contract shared by every runtime that
 * consumes `@flower/backend` — `apps/api`, `apps/worker`, `apps/scheduler`.
 *
 * Kept deliberately small: only the fields the shared backend modules
 * (`DbService`, the root logger, the auth/session primitive — task 2.5) genuinely
 * need. `apps/api` `.extend()`s this with its own HTTP / CORS / secrets /
 * idempotency / refresh-token / lockout fields (`apps/api/src/config/env.ts`);
 * `apps/worker` / `apps/scheduler` / `apps/realtime` parse exactly this set.
 * Defining `DATABASE_URL` etc. **once, here** means every process can never
 * drift.
 *
 * `@flower/backend` never imports an app's env module — dependency direction is
 * `apps/* → @flower/backend`, not the reverse (FC-3). A consumer supplies the
 * parsed config through the `BACKEND_CONFIG` token.
 */
export const backendEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  // Postgres. `DATABASE_URL` is the app connection (scoped queries drop to
  // `flower_app`); `PLATFORM_DATABASE_URL` is the separate audited platform path
  // (`flower_platform`, BYPASSRLS — ADR-0014). In dev they can be the same URL.
  DATABASE_URL: z.string().optional(),
  PLATFORM_DATABASE_URL: z.string().optional(),

  // Auth (task 1.4/1.5; moved here task 2.5 — `JwtService` needs it in every
  // process that verifies a token, not just `apps/api`, which also *signs*).
  // A dev default keeps unit tests self-contained; `apps/api`'s `loadConfig`
  // still refuses this default in production (the production check is an
  // apps/api-only concern — it is the only process that can be misconfigured
  // this way in a way that matters, since it is the only signer).
  AUTH_JWT_SECRET: z.string().min(32).default('dev-only-insecure-jwt-secret-change-me-000'),
  AUTH_ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(600),
});

export type BackendConfig = Readonly<z.infer<typeof backendEnvSchema>>;

export class EnvValidationError extends Error {
  constructor(issues: string) {
    super(`Invalid environment:\n${issues}`);
    this.name = 'EnvValidationError';
  }
}

/**
 * Parse + freeze the infrastructure env. `apps/worker` / `apps/scheduler` call
 * this directly; `apps/api` calls its own superset `loadConfig` (which reuses
 * `backendEnvSchema`) and projects the result onto `BackendConfig`.
 */
export function loadBackendConfig(source: NodeJS.ProcessEnv = process.env): BackendConfig {
  const parsed = backendEnvSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new EnvValidationError(issues);
  }
  return Object.freeze(parsed.data);
}

/** DI token carrying a validated `BackendConfig`. Provided by each runtime. */
export const BACKEND_CONFIG = Symbol('BACKEND_CONFIG');
