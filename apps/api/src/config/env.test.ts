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
});
