import { describe, expect, it } from 'vitest';
import { DomainError } from '../../common/errors/domain-error.js';
import { fiscalPolicyConfigSchema, parseFiscalPolicyConfig } from './fiscal-policy.js';

const PRICE_TAX_MODES = ['TAX_EXCLUSIVE', 'TAX_INCLUSIVE'] as const;
const ROUNDING_SCOPES = ['LINE', 'DOCUMENT'] as const;
const ROUNDING_MODES = ['HALF_UP', 'HALF_EVEN', 'DOWN', 'UP', 'HALF_DOWN'] as const;

/**
 * Task 3b.4 Checkpoint C — the strict trusted-boundary parser for
 * `country_tax_config.config`, tested in pure isolation (no DB). The
 * DB-resolution path (`LocalizationService.resolveFiscalPolicyOn`, ambiguity,
 * effective-date boundaries) is covered separately by
 * `fiscal-policy.integration.test.ts`.
 */
describe('fiscalPolicyConfigSchema — the full valid cross-product', () => {
  for (const priceTaxMode of PRICE_TAX_MODES) {
    for (const roundingScope of ROUNDING_SCOPES) {
      for (const roundingMode of ROUNDING_MODES) {
        it(`accepts { ${priceTaxMode}, ${roundingScope}, ${roundingMode} }`, () => {
          const result = fiscalPolicyConfigSchema.safeParse({
            priceTaxMode,
            roundingScope,
            roundingMode,
          });
          expect(result.success).toBe(true);
          if (result.success) {
            expect(result.data).toEqual({ priceTaxMode, roundingScope, roundingMode });
          }
        });
      }
    }
  }
});

describe('parseFiscalPolicyConfig — fail-closed rejection matrix', () => {
  const VALID = { priceTaxMode: 'TAX_EXCLUSIVE', roundingScope: 'LINE', roundingMode: 'HALF_UP' };

  it('rejects an empty object — no default {} is ever accepted', () => {
    expect(() => parseFiscalPolicyConfig({}, 'AE on 2026-01-01')).toThrow(DomainError);
  });

  it('rejects a config missing one required key', () => {
    const { roundingMode: _drop, ...missing } = VALID;
    expect(() => parseFiscalPolicyConfig(missing, 'AE on 2026-01-01')).toThrow(DomainError);
  });

  it('rejects a config with an unknown extra key (.strict())', () => {
    expect(() =>
      parseFiscalPolicyConfig({ ...VALID, unexpected: true }, 'AE on 2026-01-01'),
    ).toThrow(DomainError);
  });

  it('rejects a wrong JSON type for a valid key (number instead of string)', () => {
    expect(() =>
      parseFiscalPolicyConfig({ ...VALID, priceTaxMode: 1 }, 'AE on 2026-01-01'),
    ).toThrow(DomainError);
  });

  it('rejects an unknown enum value for a valid key', () => {
    expect(() =>
      parseFiscalPolicyConfig({ ...VALID, priceTaxMode: 'TAX_ZERO' }, 'AE on 2026-01-01'),
    ).toThrow(DomainError);
    expect(() =>
      parseFiscalPolicyConfig({ ...VALID, roundingScope: 'ITEM' }, 'AE on 2026-01-01'),
    ).toThrow(DomainError);
    expect(() =>
      parseFiscalPolicyConfig({ ...VALID, roundingMode: 'CEIL' }, 'AE on 2026-01-01'),
    ).toThrow(DomainError);
  });

  it('rejects a null value for a required key', () => {
    expect(() =>
      parseFiscalPolicyConfig({ ...VALID, roundingMode: null }, 'AE on 2026-01-01'),
    ).toThrow(DomainError);
  });

  it('rejects a non-object config (array)', () => {
    expect(() => parseFiscalPolicyConfig([VALID], 'AE on 2026-01-01')).toThrow(DomainError);
  });

  it('rejects a non-object config (primitive string/number/null)', () => {
    expect(() => parseFiscalPolicyConfig('TAX_EXCLUSIVE', 'AE on 2026-01-01')).toThrow(DomainError);
    expect(() => parseFiscalPolicyConfig(42, 'AE on 2026-01-01')).toThrow(DomainError);
    expect(() => parseFiscalPolicyConfig(null, 'AE on 2026-01-01')).toThrow(DomainError);
  });

  it('the thrown error is TAX_POLICY_CONFIG_INVALID at 500 (platform reference-data corruption, never a caller 400)', () => {
    try {
      parseFiscalPolicyConfig({}, 'AE on 2026-01-01');
      throw new Error('expected parseFiscalPolicyConfig to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(DomainError);
      expect((err as DomainError).code).toBe('TAX_POLICY_CONFIG_INVALID');
      expect((err as DomainError).status).toBe(500);
    }
  });

  it('accepts a well-formed config and returns it unchanged', () => {
    expect(parseFiscalPolicyConfig(VALID, 'AE on 2026-01-01')).toEqual(VALID);
  });
});
