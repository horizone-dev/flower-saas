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
});
