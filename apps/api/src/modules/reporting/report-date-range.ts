import { isFiscalDate } from '@flower/shared-types';
import { DomainError } from '../../common/errors/domain-error.js';

/**
 * Task 3b.10 Checkpoint A — the ONE pure civil-date contract every period report
 * uses (owner ruling OD-2): a report period is a pair of **civil calendar dates**,
 * `YYYY-MM-DD`, interpreted in the Company's accounting timezone. Period
 * membership is decided by the accounting `journal_entry.postingDate` (itself a
 * civil `DATE`), so the dates are compared as civil values — there is no
 * instant, no timezone conversion and no client-local date anywhere on this path.
 *
 * Reuses the repository's frozen date primitive (`isFiscalDate`, Task 3.9) and its
 * frozen error vocabulary (`INVALID_DATE`, `INVALID_DATE_RANGE` — the same codes
 * `customer-account-read.repository.ts` uses; `VALIDATION_FAILED` for a missing
 * value, as the Task 3.9 resolver does). It never duplicates the parser.
 *
 *   accepted : `2026-07-01`
 *   rejected : an ISO timestamp (`2026-07-01T00:00:00Z`), any `Z` / `+04:00`
 *              offset, `07/01/2026`, `2026-7-1`, an impossible date
 *              (`2026-02-30`), a non-string, and `from > to`.
 *
 * A timestamp is NEVER truncated to its date prefix (owner ruling OD-2).
 */
export interface ReportDateRange {
  /** inclusive civil start, `YYYY-MM-DD` */
  readonly from: string;
  /** inclusive civil end, `YYYY-MM-DD` */
  readonly to: string;
}

function requireCivilDate(field: 'from' | 'to', value: unknown): string {
  if (value === undefined || value === null || value === '') {
    throw new DomainError(
      'VALIDATION_FAILED',
      `"${field}" is required — a civil calendar date in YYYY-MM-DD form`,
      400,
      [{ field, issue: 'required' }],
    );
  }
  // PostgreSQL's calendar has no year 0000 (`DATE '0000-01-01'` is out of range), so a
  // value the arithmetic check would accept must still be rejected here rather than
  // surface as a database error.
  if (typeof value !== 'string' || !isFiscalDate(value) || value.startsWith('0000-')) {
    throw new DomainError(
      'INVALID_DATE',
      `"${field}" must be a civil calendar date in YYYY-MM-DD form (no time, no timezone)`,
      400,
      [{ field, issue: 'not a civil YYYY-MM-DD date' }],
    );
  }
  return value;
}

/** Parse + validate a report period. Both bounds are inclusive; `from == to` is a one-day period. */
export function parseReportDateRange(input: {
  readonly from?: unknown;
  readonly to?: unknown;
}): ReportDateRange {
  const from = requireCivilDate('from', input.from);
  const to = requireCivilDate('to', input.to);
  // `YYYY-MM-DD` with a 4-digit year compares chronologically as a plain string.
  if (from > to) {
    throw new DomainError('INVALID_DATE_RANGE', '"from" must not be after "to"', 400);
  }
  return { from, to };
}
