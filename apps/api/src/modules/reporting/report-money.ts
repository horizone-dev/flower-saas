import { currencyExponent, isKnownCurrency } from '@flower/money';
import { DomainError } from '../../common/errors/domain-error.js';
import { assertValidIanaTimezone } from '../accounting/posting-date.js';

/**
 * Task 3b.10 Checkpoint A — the shared pure money / company-authority contract of
 * every report. NO DB, NO HTTP, NO Prisma types.
 *
 * Money in a report is **exact integer minor units** (CLAUDE.md rule 15): a database
 * `SUM` is read as decimal TEXT and parsed to a `bigint`; a figure leaves the report as
 * a decimal STRING plus the report's currency code and exponent — never a JS `number`,
 * never a float, never rounded, never converted (no FX). A report only ADDS and
 * SUBTRACTS minor units, so no rounding mode is involved at all.
 *
 * Company authority (owner ruling; PHASE-3B-PLAN D3b-15): the Company's own
 * `defaultCurrency` is the single accounting currency of every figure in its reports and
 * its `accountingTimezone` is the timezone the civil report dates are expressed in. The
 * exponent comes from the frozen `@flower/money` registry (KWD / BHD / OMR = 3). A missing
 * or unknown value FAILS CLOSED — a report is never produced on a partially configured
 * company, and a currency is never guessed.
 */

export interface CompanyReportAuthority {
  readonly currencyCode: string;
  readonly currencyExponent: number;
  readonly accountingTimezone: string;
}

export function resolveCompanyReportAuthority(row: {
  readonly defaultCurrency: string | null;
  readonly accountingTimezone: string | null;
}): CompanyReportAuthority {
  if (row.defaultCurrency === null || row.defaultCurrency === '') {
    throw new DomainError(
      'REPORT_COMPANY_NOT_CONFIGURED',
      "the company has no accounting currency (Company.defaultCurrency) — a financial report can't be produced",
      409,
    );
  }
  if (!isKnownCurrency(row.defaultCurrency)) {
    throw new DomainError(
      'REPORT_COMPANY_NOT_CONFIGURED',
      "the company's accounting currency is not in the supported currency registry",
      409,
    );
  }
  if (row.accountingTimezone === null || row.accountingTimezone === '') {
    throw new DomainError(
      'REPORT_COMPANY_NOT_CONFIGURED',
      "the company has no accounting timezone (Company.accountingTimezone) — a financial report can't be produced",
      409,
    );
  }
  try {
    assertValidIanaTimezone(row.accountingTimezone);
  } catch {
    throw new DomainError(
      'REPORT_COMPANY_NOT_CONFIGURED',
      "the company's accounting timezone is not a valid IANA timezone",
      409,
    );
  }
  return {
    currencyCode: row.defaultCurrency,
    currencyExponent: currencyExponent(row.defaultCurrency),
    accountingTimezone: row.accountingTimezone,
  };
}

const INTEGER_TEXT_RE = /^-?\d+$/;

/**
 * Parse a database-side exact integer that was cast to TEXT (`SUM(bigint)::text`) into a
 * `bigint`. Strict: only an optional minus sign and digits — a decimal point, an exponent,
 * whitespace, a JS `number`, a `bigint`-in-disguise or anything else is rejected (a
 * report must never silently accept a float).
 */
export function parseMinorUnitsText(value: unknown, label: string): bigint {
  if (typeof value !== 'string' || !INTEGER_TEXT_RE.test(value)) {
    throw new RangeError(`${label} must be an exact integer string (got ${typeof value})`);
  }
  return BigInt(value);
}

/** A minor-unit amount on the wire: a decimal string, exactly — never a `number`. */
export function minorUnitsToWire(value: bigint): string {
  return value.toString();
}
