import { afterEach, describe, expect, it } from 'vitest';
import { DomainError } from '../../common/errors/domain-error.js';
import {
  inclusiveCivilDays,
  parseSalesReportRange,
  SALES_REPORT_MAX_DAYS,
  SALES_REPORT_MAX_DOCUMENTS,
} from './sales-report-range.js';

function reject(from: unknown, to: unknown): DomainError {
  try {
    parseSalesReportRange({ from, to });
  } catch (e) {
    expect(e).toBeInstanceOf(DomainError);
    return e as DomainError;
  }
  throw new Error(`expected a rejection for ${String(from)} .. ${String(to)}`);
}

describe('Sales report period cap — 90 calendar days, both bounds inclusive (owner correction 2)', () => {
  it('the cap is exactly 90', () => {
    expect(SALES_REPORT_MAX_DAYS).toBe(90n);
  });

  it('the density limit is exactly 25 000 financial documents (the second v1 limit, independent of the period)', () => {
    expect(SALES_REPORT_MAX_DOCUMENTS).toBe(25_000);
    expect(Number.isSafeInteger(SALES_REPORT_MAX_DOCUMENTS)).toBe(true);
  });

  it('one day (from == to) is allowed and counts as 1', () => {
    expect(parseSalesReportRange({ from: '2026-06-15', to: '2026-06-15' })).toEqual({
      from: '2026-06-15',
      to: '2026-06-15',
    });
    expect(inclusiveCivilDays({ from: '2026-06-15', to: '2026-06-15' })).toBe(1n);
  });

  it('90 days INCLUSIVE is allowed; 91 is rejected', () => {
    // 2026-06-01 + 89 days = 2026-08-29 → 90 dates
    expect(inclusiveCivilDays({ from: '2026-06-01', to: '2026-08-29' })).toBe(90n);
    expect(parseSalesReportRange({ from: '2026-06-01', to: '2026-08-29' })).toEqual({
      from: '2026-06-01',
      to: '2026-08-29',
    });
    expect(inclusiveCivilDays({ from: '2026-06-01', to: '2026-08-30' })).toBe(91n);
    const err = reject('2026-06-01', '2026-08-30');
    expect(err.code).toBe('REPORT_RANGE_TOO_LARGE');
    expect(err.status).toBe(400);
    expect(err.message).toContain('90');
  });

  it('the rejection is a stable reporting-domain validation error naming the field', () => {
    const err = reject('2026-01-01', '2026-12-31');
    expect(err).toMatchObject({ code: 'REPORT_RANGE_TOO_LARGE', status: 400 });
    expect(err.details).toEqual([{ field: 'to', issue: 'period exceeds 90 calendar days' }]);
    // an absurd span is still a clean rejection, never an overflow or a hang
    expect(reject('0001-01-01', '9999-12-31').code).toBe('REPORT_RANGE_TOO_LARGE');
  });

  it('the Checkpoint A date contract still comes first (its own codes, not the cap code)', () => {
    expect(reject('2026-06-01T00:00:00Z', '2026-06-02').code).toBe('INVALID_DATE');
    expect(reject('2026-02-30', '2026-03-01').code).toBe('INVALID_DATE');
    expect(reject('2026-06-10', '2026-06-01').code).toBe('INVALID_DATE_RANGE');
    expect(reject(undefined, '2026-06-01').code).toBe('VALIDATION_FAILED');
    expect(reject('2026-06-01', undefined).code).toBe('VALIDATION_FAILED');
    expect(reject('2026-06-01', 20260630).code).toBe('INVALID_DATE');
  });

  describe('leap-year and century boundaries', () => {
    it('2024 (leap): Jan 1 → Mar 30 is 90 days (allowed), → Mar 31 is 91 (rejected)', () => {
      expect(inclusiveCivilDays({ from: '2024-01-01', to: '2024-03-30' })).toBe(90n);
      expect(parseSalesReportRange({ from: '2024-01-01', to: '2024-03-30' }).to).toBe('2024-03-30');
      expect(inclusiveCivilDays({ from: '2024-01-01', to: '2024-03-31' })).toBe(91n);
      expect(reject('2024-01-01', '2024-03-31').code).toBe('REPORT_RANGE_TOO_LARGE');
    });

    it('2025 (not leap): Jan 1 → Mar 31 is 90 days (allowed), → Apr 1 is 91 (rejected)', () => {
      expect(inclusiveCivilDays({ from: '2025-01-01', to: '2025-03-31' })).toBe(90n);
      expect(parseSalesReportRange({ from: '2025-01-01', to: '2025-03-31' }).to).toBe('2025-03-31');
      expect(reject('2025-01-01', '2025-04-01').code).toBe('REPORT_RANGE_TOO_LARGE');
    });

    it('the leap day itself is one day, and a window across it counts it', () => {
      expect(inclusiveCivilDays({ from: '2024-02-29', to: '2024-02-29' })).toBe(1n);
      expect(inclusiveCivilDays({ from: '2024-02-28', to: '2024-03-01' })).toBe(3n);
      expect(inclusiveCivilDays({ from: '2023-02-28', to: '2023-03-01' })).toBe(2n);
    });

    it('century rules: 1900 is NOT a leap year, 2000 IS', () => {
      expect(inclusiveCivilDays({ from: '1900-01-01', to: '1900-03-31' })).toBe(90n);
      expect(inclusiveCivilDays({ from: '2000-01-01', to: '2000-03-30' })).toBe(90n);
      expect(inclusiveCivilDays({ from: '2000-01-01', to: '2000-03-31' })).toBe(91n);
      expect(inclusiveCivilDays({ from: '2100-02-28', to: '2100-03-01' })).toBe(2n);
    });
  });

  describe('month and year boundaries', () => {
    it('across a year end: Dec 3 → Mar 2 is exactly 90 days, → Mar 3 is 91', () => {
      expect(inclusiveCivilDays({ from: '2025-12-03', to: '2026-03-02' })).toBe(90n);
      expect(parseSalesReportRange({ from: '2025-12-03', to: '2026-03-02' }).to).toBe('2026-03-02');
      expect(reject('2025-12-03', '2026-03-03').code).toBe('REPORT_RANGE_TOO_LARGE');
    });

    it('every month length is honoured (30- and 31-day months, February)', () => {
      expect(inclusiveCivilDays({ from: '2026-01-31', to: '2026-02-01' })).toBe(2n);
      expect(inclusiveCivilDays({ from: '2026-04-30', to: '2026-05-01' })).toBe(2n);
      expect(inclusiveCivilDays({ from: '2026-02-01', to: '2026-02-28' })).toBe(28n);
      expect(inclusiveCivilDays({ from: '2026-12-31', to: '2027-01-01' })).toBe(2n);
      expect(inclusiveCivilDays({ from: '2026-01-01', to: '2026-12-31' })).toBe(365n);
      expect(inclusiveCivilDays({ from: '2024-01-01', to: '2024-12-31' })).toBe(366n);
    });
  });

  describe('process-timezone independence (Dubai, Kuwait and zones with DST on the same dates)', () => {
    const originalTz = process.env['TZ'];
    afterEach(() => {
      if (originalTz === undefined) delete process.env['TZ'];
      else process.env['TZ'] = originalTz;
    });

    // windows that CROSS a daylight-saving change of the named zone — a local-time `Date` subtraction
    // would be 23 / 25 hours off on those days and miscount; the civil arithmetic must not care
    const CASES: readonly (readonly [tz: string, from: string, to90: string, to91: string])[] = [
      ['Asia/Dubai', '2026-06-01', '2026-08-29', '2026-08-30'],
      ['Asia/Kuwait', '2026-06-01', '2026-08-29', '2026-08-30'],
      ['America/New_York', '2026-02-20', '2026-05-20', '2026-05-21'], // spring-forward 2026-03-08
      ['Europe/London', '2026-03-01', '2026-05-29', '2026-05-30'], // spring-forward 2026-03-29
      ['Pacific/Auckland', '2026-03-10', '2026-06-07', '2026-06-08'], // fall-back 2026-04-05
      ['America/Los_Angeles', '2026-10-15', '2027-01-12', '2027-01-13'], // fall-back 2026-11-01
    ];

    it.each(CASES)('%s: 90 inclusive days allowed, 91 rejected', (tz, from, to90, to91) => {
      process.env['TZ'] = tz;
      // the process timezone really is the named one (otherwise this test would prove nothing)
      const offsetJan = new Date(2026, 0, 1, 12).getTimezoneOffset();
      const probe: Record<string, number> = {
        'Asia/Dubai': -240,
        'Asia/Kuwait': -180,
        'America/New_York': 300,
        'Europe/London': 0,
        'Pacific/Auckland': -780,
        'America/Los_Angeles': 480,
      };
      expect(offsetJan).toBe(probe[tz]);

      expect(inclusiveCivilDays({ from, to: to90 })).toBe(90n);
      expect(parseSalesReportRange({ from, to: to90 })).toEqual({ from, to: to90 });
      expect(inclusiveCivilDays({ from, to: to91 })).toBe(91n);
      expect(reject(from, to91).code).toBe('REPORT_RANGE_TOO_LARGE');
    });
  });
});
