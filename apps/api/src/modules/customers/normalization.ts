import { parsePhoneNumberWithError, isSupportedCountry } from 'libphonenumber-js';
import type { CountryCode } from 'libphonenumber-js';
import { DomainError } from '../../common/errors/domain-error.js';

/**
 * Task 3b.2 — the ONLY source of `phoneE164`/`emailNormalized`. Never used as
 * an identity/uniqueness rule (contact fields are deliberately non-unique,
 * task 3b.2 §3) — this is canonicalization for exact-match search only.
 *
 * Phone region resolution is authoritative-Company-only: `+`-prefixed input
 * parses as international (no region needed); national-format input requires
 * the caller's own `Company.countryCode` as region context. This file NEVER
 * falls back to a default region (no UAE, no Branch.timezone, no
 * Company.accountingTimezone, no browser/request locale) — an absent/invalid
 * Company country for national-format input is a deterministic failure, not
 * a guess.
 */

export function normalizePhoneE164(
  input: string | null | undefined,
  companyCountryCode: string | null,
): string | null {
  if (input === null || input === undefined || input.trim() === '') return null;
  const trimmed = input.trim();
  const isInternational = trimmed.startsWith('+');

  let region: CountryCode | undefined;
  if (!isInternational) {
    if (!companyCountryCode || !isSupportedCountry(companyCountryCode)) {
      throw new DomainError(
        'CUSTOMER_PHONE_INVALID',
        'national-format phone input requires a valid Company.countryCode as region context',
        400,
        [{ field: 'phone', issue: 'no usable Company country for national-format parsing' }],
      );
    }
    region = companyCountryCode as CountryCode;
  }

  try {
    const parsed = region
      ? parsePhoneNumberWithError(trimmed, region)
      : parsePhoneNumberWithError(trimmed);
    if (!parsed.isValid()) {
      throw new Error('invalid number');
    }
    return parsed.number; // E.164
  } catch {
    throw new DomainError(
      'CUSTOMER_PHONE_INVALID',
      'phone number could not be parsed as valid',
      400,
      [{ field: 'phone', issue: 'unparseable or invalid phone number' }],
    );
  }
}

export function normalizeEmail(input: string | null | undefined): string | null {
  if (input === null || input === undefined || input.trim() === '') return null;
  return input.trim().toLowerCase();
}
