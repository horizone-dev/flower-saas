/**
 * Pure helpers for the Owner Web sales report. NO business rule lives here: every figure comes from the API's frozen report. These only
 * choose a default civil window, check the form's dates before a request, and format a share with exact integer arithmetic.
 */

const CIVIL = /^(\d{4})-(\d{2})-(\d{2})$/;

function isRealDate(s: string): boolean {
  const m = CIVIL.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (mo < 1 || mo > 12 || d < 1) return false;
  const last = new Date(Date.UTC(y, mo, 0)).getUTCDate(); // days in that month (a calendar fact, not a timezone question)
  return d <= last;
}

/**
 * The calendar date `now` falls on in `timeZone` (an IANA zone), as `YYYY-MM-DD`. A DISPLAY default for the report window only: the report
 * itself is decided by the server from the dates the owner submits. An unknown or invalid zone falls back to UTC rather than failing.
 */
export function civilToday(timeZone: string | undefined, now: Date = new Date()): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timeZone ?? 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

/** the 1st of today's month to today, as civil dates (`today` is `YYYY-MM-DD`) */
export function monthToDate(today: string): { from: string; to: string } {
  return { from: `${today.slice(0, 8)}01`, to: today };
}

export type CivilPeriod = { ok: true; from: string; to: string } | { ok: false; error: string };

export function parseCivilPeriod(from: string, to: string): CivilPeriod {
  if (!isRealDate(from) || !isRealDate(to))
    return { ok: false, error: 'Enter both dates as YYYY-MM-DD, for example 2026-11-01.' };
  if (from > to) return { ok: false, error: 'The start date must not be after the end date.' };
  return { ok: true, from, to };
}

/** `part / total` as a percentage with one decimal, from minor-unit strings, rounded half up with BigInt only */
export function percentOfTotal(part: string, total: string): string {
  const p = BigInt(part);
  const t = BigInt(total);
  if (t === 0n) return '0.0';
  const tenths = (p * 1000n * 2n + t) / (t * 2n); // round half up to one decimal
  return `${tenths / 10n}.${tenths % 10n}`;
}
