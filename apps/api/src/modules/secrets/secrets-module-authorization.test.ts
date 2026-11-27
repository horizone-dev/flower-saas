import { afterEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { loadConfig, EnvValidationError, type AppConfig } from '../../config/env.js';
import { DevCryptoProvider, DisabledCryptoProvider } from './crypto-provider.js';
import { createCryptoProvider } from './secrets.module.js';

/**
 * R-1a, defence in depth at the ONE place a DisabledCryptoProvider is built: even if a config object is assembled
 * without `loadConfig` (a test helper, a future bootstrap path), the module refuses an unauthorized disabled vault.
 */
const NOW = new Date('2026-12-01T12:00:00.000Z');
const base = loadConfig({}, NOW);
const withEnv = (over: Record<string, unknown>): AppConfig => ({ ...base, ...over }) as AppConfig;
const dev = new DevCryptoProvider(base);
const authorized = {
  SECRETS_PROVIDER: 'disabled',
  SECRETS_DISABLED_AUTHORIZATION: 'internal-alpha-only',
  SECRETS_DISABLED_UNTIL: '2026-12-31',
};

afterEach(() => vi.restoreAllMocks());

describe('R-1a: createCryptoProvider', () => {
  it('authorized + in window -> the fail-closed provider, announced once at startup with the expiry', () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const p = createCryptoProvider(withEnv(authorized), dev, NOW);
    expect(p).toBeInstanceOf(DisabledCryptoProvider);
    expect(p).not.toBe(dev);
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0]?.[0]);
    expect(line).toContain('DISABLED');
    expect(line).toContain('internal alpha only');
    expect(line).toContain('2026-12-31');
  });

  it('missing, wrong or latent authorization on a hand-built config is refused (no loadConfig in between)', () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    for (const over of [
      { SECRETS_DISABLED_AUTHORIZATION: undefined },
      { SECRETS_DISABLED_AUTHORIZATION: '' },
      { SECRETS_DISABLED_AUTHORIZATION: 'true' },
      { SECRETS_DISABLED_AUTHORIZATION: 'INTERNAL-ALPHA-ONLY' },
      { SECRETS_DISABLED_UNTIL: undefined },
      { SECRETS_DISABLED_UNTIL: '2026-11-30' }, // expired
      { SECRETS_DISABLED_UNTIL: '2099-12-31' }, // too long
      { SECRETS_DISABLED_UNTIL: '2026-02-30' }, // not a date
    ]) {
      expect(() => createCryptoProvider(withEnv({ ...authorized, ...over }), dev, NOW)).toThrow(
        EnvValidationError,
      );
    }
  });

  it('an expired authorization stops a restart, not just the first start', () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    expect(() => createCryptoProvider(withEnv(authorized), dev, NOW)).not.toThrow();
    expect(() =>
      createCryptoProvider(withEnv(authorized), dev, new Date('2027-01-01T00:00:00Z')),
    ).toThrow(EnvValidationError);
  });

  it('the dev provider and the unwired kms provider behave as before; the dev path never warns about the vault', () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    expect(createCryptoProvider(withEnv({ SECRETS_PROVIDER: 'dev' }), dev, NOW)).toBe(dev);
    expect(() => createCryptoProvider(withEnv({ SECRETS_PROVIDER: 'kms' }), dev, NOW)).toThrow(
      /no managed KMS crypto provider is wired yet/,
    );
    expect(warn).not.toHaveBeenCalled();
  });
});
