import { Money, currencyExponent, isKnownCurrency, type MoneyDTO } from '@flower/money';
import { DomainError } from '../../common/errors/domain-error.js';
import { requireUomCode } from './uom.helpers.js';

/**
 * Task 3.7 pure helpers — company per-UOM sale pricing. NO `@flower/db` import
 * (ESLint `no-raw-prisma-in-scoped-modules` — a `.helpers.ts` stays pure). All
 * money goes through `@flower/money`; this file re-implements no currency
 * arithmetic and, crucially, NEVER derives a price from a UOM conversion ratio
 * (ADR-0018 §5 — each UOM tier is priced independently).
 */

export { requireUomCode };

/** One price-tier input from the replace-set `PUT` body (SELL only — no purchase, D-6). */
export interface PriceEntryInput {
  uomCode: string;
  sell: MoneyDTO;
}

/** A stored price row as read back (SELL only in the public contract — D-6). */
export interface StoredPriceRow {
  uomCode: string;
  sellAmountMinor: bigint;
  sellCurrencyCode: string;
  sellCurrencyExponent: number;
}

/** The `/resolve` outcome reason. `null` ⇔ a price was found. */
export type CompanyPriceResolveReason =
  'NO_PRICE_SET' | 'UOM_NOT_PRICED' | 'UOM_UNRESOLVABLE' | null;

/**
 * Validate one price entry's SELL money against the company's default currency
 * (Inv-3 — the DB composite FK is the hard backstop; this is the friendly 422).
 * Returns the canonical `Money`. Throws a deterministic `DomainError` — never a
 * raw `ZodError` / `RangeError` leak.
 *
 *  - currency must be known + carry its authoritative exponent — this is the
 *    PRIMARY semantic check (the Task 3.7 body schema `structuralMoneyDtoSchema`
 *    validates SHAPE only → `400`; a structurally-valid wrong-exponent DTO
 *    reaches here and becomes a deterministic `422`; the DB composite FK
 *    `(sellCurrencyCode, sellCurrencyExponent) → currency(code, exponent)` is the
 *    hard backstop);
 *  - amount must be int64-safe (`Money` overflow guard);
 *  - `sellAmountMinor > 0` (D-8 — a master sell price is strictly positive;
 *    free/gift is discount / promotion / complimentary-line semantics, later);
 *  - `sell.currency === company.defaultCurrency` (D-2 / Inv-3).
 */
export function assertSellMoney(dto: MoneyDTO, companyDefaultCurrency: string): Money {
  if (!isKnownCurrency(dto.currency)) {
    throw new DomainError('PRICE_CURRENCY_INVALID', `unknown currency "${dto.currency}"`, 422, [
      { field: 'sell.currency', issue: 'unknown currency' },
    ]);
  }
  const authoritativeExponent = currencyExponent(dto.currency);
  if (dto.exponent !== authoritativeExponent) {
    throw new DomainError(
      'PRICE_CURRENCY_INVALID',
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
      'PRICE_CURRENCY_INVALID',
      'the sell amount is not a valid money value',
      422,
      [{ field: 'sell', issue: 'invalid money' }],
    );
  }
  if (money.amountMinor <= 0n) {
    throw new DomainError(
      'PRICE_MUST_BE_POSITIVE',
      'the sell price must be greater than zero',
      422,
      [{ field: 'sell.amountMinor', issue: 'must be > 0' }],
    );
  }
  if (dto.currency !== companyDefaultCurrency) {
    throw new DomainError(
      'PRICE_CURRENCY_MISMATCH',
      `the sell price must be in the company's default currency (${companyDefaultCurrency}), got ${dto.currency}`,
      422,
      [{ field: 'sell.currency', issue: 'must equal the company default currency' }],
    );
  }
  return money;
}

/** A stored SELL row → the wire `MoneyDTO`. */
export function storedSellToDto(row: StoredPriceRow): MoneyDTO {
  return Money.ofMinor(row.sellAmountMinor, row.sellCurrencyCode).toDTO();
}

/**
 * Translate a known DB constraint violation into a deterministic domain error.
 * DB FKs are defence-in-depth (Inv-3); a known race must never surface as a raw
 * `P2002` / `P2003` / SQL constraint name / raw pg message / a generic 500.
 * An unknown / unexpected error is re-thrown unchanged (→ a real 500, logged,
 * no DB detail leaked).
 */
export function mapPricingDbError(e: unknown): never {
  const err = e as { code?: string; meta?: Record<string, unknown>; message?: string } | null;
  const blob = `${err?.code ?? ''} ${JSON.stringify(err?.meta ?? {})} ${err?.message ?? ''}`;
  const isFk = err?.code === 'P2003' || err?.code === '23503' || /foreign key/i.test(blob);
  const isUnique = err?.code === 'P2002' || err?.code === '23505' || /unique/i.test(blob);

  // sell currency ≠ company default currency (the composite FK to
  // company(tenantId, id, defaultCurrency))
  if (isFk && /company_currency_fkey|default_?currency|defaultCurrency/i.test(blob)) {
    throw new DomainError(
      'PRICE_CURRENCY_MISMATCH',
      "the sell price currency does not match the company's default currency",
      422,
      [{ field: 'sell.currency', issue: 'must equal the company default currency' }],
    );
  }
  // (code, exponent) is not an authoritative currency pair (the FK to currency(code, exponent))
  if (isFk && /currency_pair_fkey|\bcurrency\b/i.test(blob)) {
    throw new DomainError(
      'PRICE_CURRENCY_INVALID',
      'the sell currency / exponent pair is not a valid currency',
      422,
      [{ field: 'sell.exponent', issue: 'not an authoritative currency pair' }],
    );
  }
  // the (company, variant) aggregate vanished mid-write (company/variant deleted
  // concurrently) — treat as a not-found, never a raw FK 500
  if (isFk && /price_set_fkey|price_set/i.test(blob)) {
    throw new DomainError('NOT_FOUND', 'the company or variant no longer exists', 404);
  }
  // a duplicate (tenant, company, variant, uomCode) — the replace-set deletes
  // first, so this can only be a concurrent double-write; surface it as a version
  // conflict so the caller re-fetches and retries deterministically
  if (isUnique && /company_variant_uom_price|scope_uom_key/i.test(blob)) {
    throw new DomainError(
      'PRICE_SET_VERSION_CONFLICT',
      'the price set changed elsewhere — re-fetch the current version and retry',
      409,
    );
  }
  throw e as Error;
}
