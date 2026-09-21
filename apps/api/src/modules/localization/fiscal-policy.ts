import { z } from 'zod';
import { DomainError } from '../../common/errors/domain-error.js';

/**
 * Task 3b.4 Checkpoint C — the strict trusted-boundary parser for
 * `country_tax_config.config` (a JSONB column, `@default("{}")`, previously
 * completely unused). Frozen shape (docs/phase-3 3b.4 contract):
 *
 *   { priceTaxMode: 'TAX_EXCLUSIVE'|'TAX_INCLUSIVE',
 *     roundingScope: 'LINE'|'DOCUMENT',
 *     roundingMode: 'HALF_UP'|'HALF_EVEN'|'DOWN'|'UP'|'HALF_DOWN' }
 *
 * `.strict()` — an empty `{}`, a missing key, an unknown extra key, a wrong
 * JSON type, an unknown enum value, a `null` value, or a non-object config
 * (e.g. an array) are ALL rejected. Raw JSON is NEVER cast directly to the
 * policy type anywhere in this codebase — every read goes through
 * {@link parseFiscalPolicyConfig}. The migration's SQL-side backfill
 * (`20260921120000_sale_tax_fiscal_policy_v1v2`) enforces the exact same
 * shape independently, in SQL, before ever trusting a legacy row.
 */
export const fiscalPolicyConfigSchema = z
  .object({
    priceTaxMode: z.enum(['TAX_EXCLUSIVE', 'TAX_INCLUSIVE']),
    roundingScope: z.enum(['LINE', 'DOCUMENT']),
    roundingMode: z.enum(['HALF_UP', 'HALF_EVEN', 'DOWN', 'UP', 'HALF_DOWN']),
  })
  .strict();

export type FiscalPolicyConfig = z.infer<typeof fiscalPolicyConfigSchema>;

/**
 * Parses an already-resolved (single, unambiguous, effective-dated)
 * `country_tax_config.config` value. Fails closed with `500
 * TAX_POLICY_CONFIG_INVALID` on any shape violation — this is platform
 * reference-data corruption, never a caller-fixable `400`, matching the
 * existing `TAX_REGIME_NOT_CONFIGURED`/`TAX_RATE_AMBIGUOUS` (500)
 * convention. `context` is a short, non-sensitive description used only in
 * the error message (e.g. `"AE on 2026-01-01"`).
 */
export function parseFiscalPolicyConfig(raw: unknown, context: string): FiscalPolicyConfig {
  const parsed = fiscalPolicyConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new DomainError(
      'TAX_POLICY_CONFIG_INVALID',
      `country_tax_config.config for ${context} does not match the frozen fiscal-policy shape: ${parsed.error.message}`,
      500,
    );
  }
  return parsed.data;
}
