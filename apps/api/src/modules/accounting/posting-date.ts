import { DomainError } from '../../common/errors/domain-error.js';

/**
 * Derives the immutable civil `postingDate` (`YYYY-MM-DD`) for a journal entry
 * from a trusted server instant + `Company.accountingTimezone`. Distinct from
 * task 3.9's tax `?date=` contract: that is a caller-supplied civil date used
 * transiently for rate resolution; this is server-derived from an instant and
 * stored immutably on the entry.
 *
 * No date library — `Intl.DateTimeFormat` with the `en-CA` locale formats a
 * `Date` as `YYYY-MM-DD` in an arbitrary IANA zone, which is exactly what's
 * needed here.
 */
/**
 * Validates an IANA timezone string, shared by `derivePostingDate` and the
 * Checkpoint D `PATCH …/accounting/config/timezone` endpoint — one validator,
 * never duplicated (task 3b.1 Checkpoint D).
 */
export function assertValidIanaTimezone(timezone: string): void {
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: timezone });
  } catch (err) {
    if (err instanceof RangeError) {
      throw new DomainError(
        'ACCOUNTING_TIMEZONE_INVALID',
        `"${timezone}" is not a valid IANA timezone`,
        400,
      );
    }
    throw err;
  }
}

export function derivePostingDate(instant: Date, accountingTimezone: string): string {
  assertValidIanaTimezone(accountingTimezone);
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: accountingTimezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return formatter.format(instant);
}
