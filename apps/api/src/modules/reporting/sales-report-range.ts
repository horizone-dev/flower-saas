import { DomainError } from '../../common/errors/domain-error.js';
import { parseReportDateRange, type ReportDateRange } from './report-date-range.js';

/**
 * Task 3b.10 Checkpoint B correction (owner correction 2) — the Sales Financial Report period cap.
 *
 * FIRST RELEASE: a Sales report period may span at most **90 calendar days, both bounds inclusive** —
 * `from == to` is one day, 90 dates are allowed, 91 are rejected. The limit is SALES-specific: it is NOT
 * applied to the Trial Balance (whose cost does not depend on the period) and says nothing about Tender
 * Totals (measured separately in its own checkpoint).
 *
 * The number comes from LOCAL Testcontainers measurements (400 000 invoices: 1 day ≈ 18 ms, 90 days ≈ 5 s,
 * full history ≈ 19 s against a ≈ 20 s scoped-transaction timeout). It is a first-release OPERATIONAL SAFETY
 * limit, not a production throughput SLA.
 *
 * Enforced BELOW any controller — by the Sales service and again by the Sales repository, the only door to the
 * database — so every caller gets the same rule. It reuses the Checkpoint A strict civil-date parser (it never
 * re-parses a date) and counts days by PURE civil-calendar integer arithmetic (BigInt): no JS `Date`, no local
 * time, no process timezone, no UTC conversion — a civil date is a calendar value, not an instant.
 */
export const SALES_REPORT_MAX_DAYS = 90n;

/**
 * Sales Financial Report v1 DENSITY limit — the ONE authoritative number: at most **25 000 financial documents**
 * per invocation. The date cap bounds the calendar, not the volume: a company that issues 100 000 invoices inside
 * one 90-day window needed ≈ 17 s for the statement alone (a LOCAL test-container measurement, not a production
 * SLA) against the ≈ 20 s scoped-transaction timeout, so the report also refuses a scope that holds more.
 *
 * A financial document is an Invoice, a CreditNote or a CancellationCharge — counted by their sealed journal in
 * the period. A Payment, a Refund, a CustomerAdvance, a PaymentAttempt or a SettlementApplication is NOT a
 * document of this report and is never counted. The COMPANY report counts the whole company; a BRANCH report
 * counts only the requested branch. Above the limit the report is rejected (`REPORT_RESULT_TOO_LARGE`, 422)
 * by the first stage of the one statement, before any heavy evidence is read.
 */
export const SALES_REPORT_MAX_DOCUMENTS = 25_000;

/** Days since 1970-01-01 of a civil `YYYY-MM-DD` date (proleptic Gregorian) — pure integer arithmetic. */
function civilDayNumber(date: string): bigint {
  const year = BigInt(date.slice(0, 4));
  const month = BigInt(date.slice(5, 7));
  const day = BigInt(date.slice(8, 10));
  // the standard days-from-civil algorithm (March-based year, 400-year eras). The parser rejects year 0000, so
  // every operand is non-negative and BigInt's truncating division equals the floor the algorithm needs.
  const y = month <= 2n ? year - 1n : year;
  const era = y / 400n;
  const yearOfEra = y - era * 400n;
  const monthIndex = month > 2n ? month - 3n : month + 9n;
  const dayOfYear = (153n * monthIndex + 2n) / 5n + day - 1n;
  const dayOfEra = yearOfEra * 365n + yearOfEra / 4n - yearOfEra / 100n + dayOfYear;
  return era * 146097n + dayOfEra - 719468n;
}

/** The number of civil dates in `[from, to]`, both inclusive (a one-day period is 1). */
export function inclusiveCivilDays(range: ReportDateRange): bigint {
  return civilDayNumber(range.to) - civilDayNumber(range.from) + 1n;
}

/**
 * Parse + validate a Sales report period: the Checkpoint A civil-date contract, then the 90-day cap.
 * Throws `REPORT_RANGE_TOO_LARGE` (400) for a longer period.
 */
export function parseSalesReportRange(input: {
  readonly from?: unknown;
  readonly to?: unknown;
}): ReportDateRange {
  const range = parseReportDateRange(input);
  if (inclusiveCivilDays(range) > SALES_REPORT_MAX_DAYS) {
    throw new DomainError(
      'REPORT_RANGE_TOO_LARGE',
      `a Sales Financial Report period may span at most ${SALES_REPORT_MAX_DAYS} calendar days (both dates inclusive)`,
      400,
      [{ field: 'to', issue: `period exceeds ${SALES_REPORT_MAX_DAYS} calendar days` }],
    );
  }
  return range;
}
