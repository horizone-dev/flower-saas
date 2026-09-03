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
});

export type AppConfig = Readonly<z.infer<typeof envSchema>>;

export class EnvValidationError extends Error {
  constructor(issues: string) {
    super(`Invalid environment:\n${issues}`);
    this.name = 'EnvValidationError';
  }
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new EnvValidationError(issues);
  }
  return Object.freeze(parsed.data);
}

/** DI token for the validated config. */
export const APP_CONFIG = Symbol('APP_CONFIG');
