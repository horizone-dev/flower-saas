import { describe, it, expect } from 'vitest';
import { loadConfig, EnvValidationError } from './env.js';

describe('loadConfig', () => {
  it('applies defaults when the environment is empty', () => {
    const cfg = loadConfig({});
    expect(cfg.API_PORT).toBe(3001);
    expect(cfg.NODE_ENV).toBe('development');
    expect(cfg.POSTGRES_PORT).toBe(5432);
  });

  it('coerces numeric strings', () => {
    const cfg = loadConfig({ API_PORT: '4000', REDIS_PORT: '6380' });
    expect(cfg.API_PORT).toBe(4000);
    expect(cfg.REDIS_PORT).toBe(6380);
  });

  // ══════════════ Task 3b.5 Checkpoint G final security/operational pass
  // §2 — explicit, operationally-safe bounds (not merely "positive
  // integer"): the tick interval has a floor guarding against an
  // accidental tight loop, and a defensive ceiling; the batch size has a
  // floor of 1 and a finite ceiling bounding per-tick DB/memory pressure.
  // See `env.ts`'s own doc comment on these two fields for the exact
  // reasoning behind 1000/300_000/1/500. ═══════════════════════════════
  it('webhook recovery tick interval: defaults, valid range, and every rejection boundary', () => {
    const cfg = loadConfig({});
    expect(cfg.WEBHOOK_RECOVERY_TICK_INTERVAL_MS).toBe(30_000);

    // a normal, mid-range value is accepted.
    expect(
      loadConfig({ WEBHOOK_RECOVERY_TICK_INTERVAL_MS: '5000' }).WEBHOOK_RECOVERY_TICK_INTERVAL_MS,
    ).toBe(5000);
    // the exact floor/ceiling are inclusive and accepted.
    expect(
      loadConfig({ WEBHOOK_RECOVERY_TICK_INTERVAL_MS: '1000' }).WEBHOOK_RECOVERY_TICK_INTERVAL_MS,
    ).toBe(1000);
    expect(
      loadConfig({ WEBHOOK_RECOVERY_TICK_INTERVAL_MS: '300000' }).WEBHOOK_RECOVERY_TICK_INTERVAL_MS,
    ).toBe(300_000);

    expect(() => loadConfig({ WEBHOOK_RECOVERY_TICK_INTERVAL_MS: '0' })).toThrow(
      EnvValidationError,
    );
    expect(() => loadConfig({ WEBHOOK_RECOVERY_TICK_INTERVAL_MS: '-1' })).toThrow(
      EnvValidationError,
    );
    expect(() => loadConfig({ WEBHOOK_RECOVERY_TICK_INTERVAL_MS: 'not-a-number' })).toThrow(
      EnvValidationError,
    );
    // below the 1000ms floor — a value that WOULD create a tight loop.
    expect(() => loadConfig({ WEBHOOK_RECOVERY_TICK_INTERVAL_MS: '1' })).toThrow(
      EnvValidationError,
    );
    expect(() => loadConfig({ WEBHOOK_RECOVERY_TICK_INTERVAL_MS: '999' })).toThrow(
      EnvValidationError,
    );
    // above the 300_000ms (5 minute) ceiling — an extreme, unreasonable value.
    expect(() => loadConfig({ WEBHOOK_RECOVERY_TICK_INTERVAL_MS: '300001' })).toThrow(
      EnvValidationError,
    );
    expect(() => loadConfig({ WEBHOOK_RECOVERY_TICK_INTERVAL_MS: '999999999' })).toThrow(
      EnvValidationError,
    );
  });

  it('webhook recovery batch size: defaults, valid range, and every rejection boundary', () => {
    const cfg = loadConfig({});
    expect(cfg.WEBHOOK_RECOVERY_BATCH_SIZE).toBe(20);

    expect(loadConfig({ WEBHOOK_RECOVERY_BATCH_SIZE: '5' }).WEBHOOK_RECOVERY_BATCH_SIZE).toBe(5);
    expect(loadConfig({ WEBHOOK_RECOVERY_BATCH_SIZE: '1' }).WEBHOOK_RECOVERY_BATCH_SIZE).toBe(1);
    expect(loadConfig({ WEBHOOK_RECOVERY_BATCH_SIZE: '500' }).WEBHOOK_RECOVERY_BATCH_SIZE).toBe(
      500,
    );

    expect(() => loadConfig({ WEBHOOK_RECOVERY_BATCH_SIZE: '0' })).toThrow(EnvValidationError);
    expect(() => loadConfig({ WEBHOOK_RECOVERY_BATCH_SIZE: '-5' })).toThrow(EnvValidationError);
    expect(() => loadConfig({ WEBHOOK_RECOVERY_BATCH_SIZE: 'not-a-number' })).toThrow(
      EnvValidationError,
    );
    // above the 500 ceiling — never effectively unbounded.
    expect(() => loadConfig({ WEBHOOK_RECOVERY_BATCH_SIZE: '501' })).toThrow(EnvValidationError);
    expect(() => loadConfig({ WEBHOOK_RECOVERY_BATCH_SIZE: '1000000' })).toThrow(
      EnvValidationError,
    );
  });

  it('has explicit idempotency defaults, coercible from the environment', () => {
    const cfg = loadConfig({});
    expect(cfg.IDEMPOTENCY_TTL_SECONDS).toBe(60 * 60 * 24);
    expect(cfg.IDEMPOTENCY_STALE_LOCK_SECONDS).toBe(120);
    expect(cfg.IDEMPOTENCY_MAX_SNAPSHOT_BYTES).toBe(64 * 1024);
    expect(cfg.IDEMPOTENCY_WAIT_MS).toBe(5000);
    const overridden = loadConfig({
      IDEMPOTENCY_TTL_SECONDS: '3600',
      IDEMPOTENCY_STALE_LOCK_SECONDS: '30',
      IDEMPOTENCY_MAX_SNAPSHOT_BYTES: '4096',
      IDEMPOTENCY_WAIT_MS: '2000',
    });
    expect(overridden.IDEMPOTENCY_TTL_SECONDS).toBe(3600);
    expect(overridden.IDEMPOTENCY_STALE_LOCK_SECONDS).toBe(30);
    expect(overridden.IDEMPOTENCY_MAX_SNAPSHOT_BYTES).toBe(4096);
    expect(overridden.IDEMPOTENCY_WAIT_MS).toBe(2000);
    expect(() => loadConfig({ IDEMPOTENCY_TTL_SECONDS: '0' })).toThrow(EnvValidationError);
    expect(() => loadConfig({ IDEMPOTENCY_WAIT_MS: '0' })).toThrow(EnvValidationError);
  });

  it('fails fast on an invalid value', () => {
    expect(() => loadConfig({ NODE_ENV: 'staging' })).toThrow(EnvValidationError);
    expect(() => loadConfig({ API_PORT: '-1' })).toThrow(EnvValidationError);
    expect(() => loadConfig({ S3_ENDPOINT: 'not-a-url' })).toThrow(EnvValidationError);
  });

  it('returns a frozen object', () => {
    const cfg = loadConfig({});
    expect(Object.isFrozen(cfg)).toBe(true);
  });

  it('refuses the dev secrets provider in production (G16)', () => {
    const prodBase = {
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://x',
      AUTH_JWT_SECRET: 'a-real-production-jwt-secret-value-32+',
      SECRETS_MASTER_KEY: 'a-real-production-master-key-value-32+chars',
      CORS_ORIGINS: 'https://pos.acme.com',
    };
    expect(() => loadConfig(prodBase)).toThrow(/SECRETS_PROVIDER/);
    expect(() => loadConfig({ ...prodBase, SECRETS_PROVIDER: 'kms' })).not.toThrow();
    expect(() =>
      loadConfig({
        ...prodBase,
        SECRETS_PROVIDER: 'kms',
        SECRETS_MASTER_KEY: 'dev-only-insecure-secrets-master-key-change-me-000',
      }),
    ).toThrow(/SECRETS_MASTER_KEY/);
  });

  it('the dev secrets provider is the default outside production', () => {
    const cfg = loadConfig({});
    expect(cfg.SECRETS_PROVIDER).toBe('dev');
  });

  it('refuses a wildcard or localhost CORS origin in production (credentialed cookie flow)', () => {
    const prodBase = {
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://x',
      AUTH_JWT_SECRET: 'a-real-production-jwt-secret-value-32+',
      SECRETS_PROVIDER: 'kms',
      SECRETS_MASTER_KEY: 'a-real-production-master-key-value-32+chars',
    };
    expect(() => loadConfig({ ...prodBase, CORS_ORIGINS: '*' })).toThrow(/CORS_ORIGINS/);
    expect(() =>
      loadConfig({ ...prodBase, CORS_ORIGINS: 'https://pos.acme.com,http://localhost:3200' }),
    ).toThrow(/CORS_ORIGINS/);
    expect(() =>
      loadConfig({ ...prodBase, CORS_ORIGINS: 'https://pos.acme.com,https://owner.acme.com' }),
    ).not.toThrow();
  });

  it('leaves the localhost CORS defaults alone outside production', () => {
    const cfg = loadConfig({});
    expect(cfg.CORS_ORIGINS).toContain('localhost');
  });
});
