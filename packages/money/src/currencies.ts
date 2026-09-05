/**
 * Currency reference table. The exponent is the number of decimal places in the
 * currency's minor unit (ISO 4217). GCC 3-decimal currencies (KWD, BHD, OMR) are
 * first-class — a 2-decimal assumption anywhere is a defect (ARCHITECTURE §45, ADR-0006).
 *
 * **This static table is the pure arithmetic authority.** `packages/money` has no
 * I/O and never reads the database. The tenant-configurable `Currency` reference
 * table in `packages/db` is authoritative for *which* currencies a tenant/company
 * operates in and for display metadata, but its `exponent` for any code here MUST
 * equal this table's — a Testcontainers parity test in `packages/db`
 * (`gcc-reference-data.test.ts`) enforces that and is build-blocking. Adding a
 * currency is a deliberate code change here plus a DB seed, never one without the
 * other.
 */

export interface CurrencyInfo {
  readonly code: string;
  /** decimal places in the minor unit: 0, 2 or 3 */
  readonly exponent: number;
  readonly nameEn: string;
}

const TABLE: Record<string, CurrencyInfo> = {
  AED: { code: 'AED', exponent: 2, nameEn: 'UAE Dirham' },
  SAR: { code: 'SAR', exponent: 2, nameEn: 'Saudi Riyal' },
  QAR: { code: 'QAR', exponent: 2, nameEn: 'Qatari Riyal' },
  KWD: { code: 'KWD', exponent: 3, nameEn: 'Kuwaiti Dinar' },
  BHD: { code: 'BHD', exponent: 3, nameEn: 'Bahraini Dinar' },
  OMR: { code: 'OMR', exponent: 3, nameEn: 'Omani Rial' },
  USD: { code: 'USD', exponent: 2, nameEn: 'US Dollar' },
  EUR: { code: 'EUR', exponent: 2, nameEn: 'Euro' },
};

export type CurrencyCode = keyof typeof TABLE | (string & {});

export class UnknownCurrencyError extends Error {
  constructor(code: string) {
    super(`Unknown currency: ${code}`);
    this.name = 'UnknownCurrencyError';
  }
}

export function getCurrency(code: string): CurrencyInfo {
  const info = TABLE[code];
  if (!info) throw new UnknownCurrencyError(code);
  return info;
}

export function isKnownCurrency(code: string): boolean {
  return code in TABLE;
}

export function currencyExponent(code: string): number {
  return getCurrency(code).exponent;
}

export const KNOWN_CURRENCIES: readonly string[] = Object.freeze(Object.keys(TABLE));
