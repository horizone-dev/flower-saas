import { Money, currencyExponent, isKnownCurrency, type MoneyDTO } from '@flower/money';
import { duplicateVariantIds, isAscendingByVariantId } from '@flower/shared-types';
import { DomainError } from '../../common/errors/domain-error.js';
import { requireUomCode } from './uom.helpers.js';

/**
 * Task 3.8 pure helpers — branch price override + branch availability. NO
 * `@flower/db` import (ESLint `no-raw-prisma-in-scoped-modules` — a `.helpers.ts`
 * stays pure). All money goes through `@flower/money`; this file re-implements no
 * currency arithmetic and NEVER derives an override price from a UOM conversion
 * ratio (ADR-0018 §5 — each branch UOM tier is an independent stored SELL value).
 */

export { requireUomCode, duplicateVariantIds, isAscendingByVariantId };

/** One override tier from the branch replace-set `PUT` body (SELL only — BD-9). */
export interface BranchPriceEntryInput {
  uomCode: string;
  sell: MoneyDTO;
}

/** A stored branch override row as read back (SELL only in the public contract). */
export interface StoredBranchPriceRow {
  uomCode: string;
  overrideAmountMinor: bigint;
  overrideCurrencyCode: string;
  overrideCurrencyExponent: number;
}

/** The branch `/resolve` outcome reason. `null` ⇔ a price was found. */
export type BranchPriceResolveReason =
  'NO_PRICE_SET' | 'UOM_NOT_PRICED' | 'UOM_UNRESOLVABLE' | null;

/**
 * Validate one override entry's SELL money against the company's default currency
 * (§9 — the DB composite FK is the hard backstop; this is the friendly `422`).
 * Returns the canonical `Money`. Throws a deterministic `DomainError` — never a
 * raw `ZodError` / `RangeError` leak.
 *
 *  - currency must be known + carry its authoritative exponent — the PRIMARY
 *    semantic check (`structuralMoneyDtoSchema` validates SHAPE only → `400`; a
 *    structurally-valid wrong value reaches here → deterministic `422`);
 *  - amount must be int64-safe (`Money` overflow guard);
 *  - `overrideAmountMinor > 0` (a branch override sell price is strictly positive);
 *  - `sell.currency === company.defaultCurrency` (§9).
 */
export function assertBranchOverrideMoney(dto: MoneyDTO, companyDefaultCurrency: string): Money {
  if (!isKnownCurrency(dto.currency)) {
    throw new DomainError(
      'BRANCH_PRICE_CURRENCY_INVALID',
      `unknown currency "${dto.currency}"`,
      422,
      [{ field: 'sell.currency', issue: 'unknown currency' }],
    );
  }
  const authoritativeExponent = currencyExponent(dto.currency);
  if (dto.exponent !== authoritativeExponent) {
    throw new DomainError(
      'BRANCH_PRICE_CURRENCY_INVALID',
      `exponent ${dto.exponent} is not the authoritative exponent for ${dto.currency} (${authoritativeExponent})`,
      422,
      [{ field: 'sell.exponent', issue: 'exponent does not match currency' }],
    );
  }
  let money: Money;
  try {
    money = Money.fromDTO(dto);
  } catch {
    throw new DomainError(
      'BRANCH_PRICE_CURRENCY_INVALID',
      'the override amount is not a valid money value',
      422,
      [{ field: 'sell', issue: 'invalid money' }],
    );
  }
  if (money.amountMinor <= 0n) {
    throw new DomainError(
      'BRANCH_PRICE_MUST_BE_POSITIVE',
      'the branch override price must be greater than zero',
      422,
      [{ field: 'sell.amountMinor', issue: 'must be > 0' }],
    );
  }
  if (dto.currency !== companyDefaultCurrency) {
    throw new DomainError(
      'BRANCH_PRICE_CURRENCY_MISMATCH',
      `the branch override price must be in the company's default currency (${companyDefaultCurrency}), got ${dto.currency}`,
      422,
      [{ field: 'sell.currency', issue: 'must equal the company default currency' }],
    );
  }
  return money;
}

/** A stored branch override row → the wire `MoneyDTO`. */
export function storedOverrideToDto(row: StoredBranchPriceRow): MoneyDTO {
  return Money.ofMinor(row.overrideAmountMinor, row.overrideCurrencyCode).toDTO();
}

/**
 * Translate a known DB constraint violation into a deterministic domain error.
 * DB FKs are defence-in-depth; a known race must never surface as a raw
 * `P2002` / `P2003` / SQL constraint name / raw pg message / a generic 500, and
 * a sibling branch id hidden by scope must never leak. An unknown error is
 * re-thrown unchanged (→ a real 500, logged, no DB detail returned).
 */
export function mapBranchPricingDbError(e: unknown): never {
  const err = e as { code?: string; meta?: Record<string, unknown>; message?: string } | null;
  const blob = `${err?.code ?? ''} ${JSON.stringify(err?.meta ?? {})} ${err?.message ?? ''}`;
  const isFk = err?.code === 'P2003' || err?.code === '23503' || /foreign key/i.test(blob);
  const isUnique = err?.code === 'P2002' || err?.code === '23505' || /unique/i.test(blob);

  // override currency ≠ company default currency (composite FK to company(...))
  if (isFk && /company_currency_fkey|default_?currency|defaultCurrency/i.test(blob)) {
    throw new DomainError(
      'BRANCH_PRICE_CURRENCY_MISMATCH',
      "the branch override currency does not match the company's default currency",
      422,
      [{ field: 'sell.currency', issue: 'must equal the company default currency' }],
    );
  }
  // (code, exponent) is not an authoritative currency pair (FK to currency(code, exponent))
  if (isFk && /currency_pair_fkey|\bcurrency\b/i.test(blob)) {
    throw new DomainError(
      'BRANCH_PRICE_CURRENCY_INVALID',
      'the override currency / exponent pair is not a valid currency',
      422,
      [{ field: 'sell.exponent', issue: 'not an authoritative currency pair' }],
    );
  }
  // the aggregate / branch / variant vanished mid-write — treat as not-found
  if (
    isFk &&
    /price_set_fkey|tenant_variant_fkey|tenant_company_branch_fkey|price_set/i.test(blob)
  ) {
    throw new DomainError('NOT_FOUND', 'the branch, company or variant no longer exists', 404);
  }
  // a duplicate (tenant, company, branch, variant, uomCode) — the replace-set
  // deletes first, so this can only be a concurrent double-write; surface it as a
  // version conflict so the caller re-fetches and retries deterministically
  if (isUnique && /branch_variant_uom_price|scope_uom_key/i.test(blob)) {
    throw new DomainError(
      'BRANCH_PRICE_SET_VERSION_CONFLICT',
      'the branch price set changed elsewhere — re-fetch the current version and retry',
      409,
    );
  }
  if (isUnique && /branch_variant_price_set|scope_key/i.test(blob)) {
    throw new DomainError(
      'BRANCH_PRICE_SET_VERSION_CONFLICT',
      'the branch price set changed elsewhere — re-fetch the current version and retry',
      409,
    );
  }
  throw e as Error;
}
