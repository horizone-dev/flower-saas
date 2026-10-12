import { describe, expect, it } from 'vitest';
import { DomainError } from '../../common/errors/domain-error.js';
import { parseReportDateRange } from './report-date-range.js';

function failure(input: { from?: unknown; to?: unknown }): DomainError {
  try {
    parseReportDateRange(input);
  } catch (e) {
    if (e instanceof DomainError) return e;
    throw e;
  }
  throw new Error('expected a DomainError');
}

describe('parseReportDateRange — the civil-date contract (owner ruling OD-2)', () => {
  it('accepts two civil YYYY-MM-DD dates, verbatim (no conversion, no truncation)', () => {
    expect(parseReportDateRange({ from: '2026-07-01', to: '2026-07-31' })).toEqual({
      from: '2026-07-01',
      to: '2026-07-31',
    });
  });

  it('accepts a one-day period (from == to) and a leap day', () => {
    expect(parseReportDateRange({ from: '2028-02-29', to: '2028-02-29' })).toEqual({
      from: '2028-02-29',
      to: '2028-02-29',
    });
  });

  it.each([
    ['an ISO instant', '2026-07-01T00:00:00Z'],
    ['an ISO instant with milliseconds', '2026-07-01T00:00:00.000Z'],
    ['a +04:00 offset', '2026-07-01T00:00:00+04:00'],
    ['a trailing Z', '2026-07-01Z'],
    ['a space-separated time', '2026-07-01 10:00'],
    ['a US format', '07/01/2026'],
    ['a single-digit month', '2026-7-01'],
    ['a single-digit day', '2026-07-1'],
    ['an impossible date', '2026-02-30'],
    ['a non-leap Feb 29', '2027-02-29'],
    ['month 13', '2026-13-01'],
    ['month 00', '2026-00-10'],
    ['day 00', '2026-07-00'],
    ['year 0000 (PostgreSQL has no year zero)', '0000-01-01'],
    ['surrounding whitespace', ' 2026-07-01'],
    ['an epoch number as text', '1782864000000'],
  ])('rejects %s as INVALID_DATE (never truncated to a date prefix)', (_name, bad) => {
    for (const field of ['from', 'to'] as const) {
      const input = { from: '2026-07-01', to: '2026-07-31', [field]: bad };
      const err = failure(input);
      expect(err.code).toBe('INVALID_DATE');
      expect(err.status).toBe(400);
      expect(err.details?.[0]?.field).toBe(field);
    }
  });

  it.each([
    ['a JS Date', new Date('2026-07-01T00:00:00Z')],
    ['a number', 20260701],
    ['an object', { y: 2026 }],
    ['an array', ['2026-07-01']],
    ['a boolean', true],
  ])('rejects %s (not a string) as INVALID_DATE', (_name, bad) => {
    expect(failure({ from: bad, to: '2026-07-31' }).code).toBe('INVALID_DATE');
  });

  it.each([undefined, null, ''])(
    'a missing bound (%j) is VALIDATION_FAILED, naming the field',
    (m) => {
      const noFrom = failure({ from: m, to: '2026-07-31' });
      expect(noFrom.code).toBe('VALIDATION_FAILED');
      expect(noFrom.status).toBe(400);
      expect(noFrom.details?.[0]).toEqual({ field: 'from', issue: 'required' });
      const noTo = failure({ from: '2026-07-01', to: m });
      expect(noTo.code).toBe('VALIDATION_FAILED');
      expect(noTo.details?.[0]).toEqual({ field: 'to', issue: 'required' });
    },
  );

  it('rejects from > to with the repository INVALID_DATE_RANGE convention', () => {
    const err = failure({ from: '2026-08-01', to: '2026-07-31' });
    expect(err.code).toBe('INVALID_DATE_RANGE');
    expect(err.status).toBe(400);
  });

  it('compares chronologically across a year boundary (string order == date order)', () => {
    expect(parseReportDateRange({ from: '2025-12-31', to: '2026-01-01' }).to).toBe('2026-01-01');
    expect(failure({ from: '2026-01-01', to: '2025-12-31' }).code).toBe('INVALID_DATE_RANGE');
  });

  it('is independent of the process timezone: no Date is ever constructed from the input', () => {
    const before = process.env['TZ'];
    try {
      for (const tz of ['UTC', 'Asia/Dubai', 'America/Los_Angeles', 'Pacific/Kiritimati']) {
        process.env['TZ'] = tz;
        expect(parseReportDateRange({ from: '2026-03-31', to: '2026-04-01' })).toEqual({
          from: '2026-03-31',
          to: '2026-04-01',
        });
      }
    } finally {
      if (before === undefined) delete process.env['TZ'];
      else process.env['TZ'] = before;
    }
  });
});
