import { describe, expect, it } from 'vitest';
import { civilToday, monthToDate, parseCivilPeriod, percentOfTotal } from './reports';

describe('civilToday — the calendar date NOW in the shop’s time zone (not the server’s)', () => {
  it('a sale at 21:00 UTC is already tomorrow in Dubai', () => {
    const t = new Date('2026-11-14T21:00:00Z');
    expect(civilToday('Asia/Dubai', t)).toBe('2026-11-15');
    expect(civilToday('UTC', t)).toBe('2026-11-14');
    expect(civilToday(undefined, t)).toBe('2026-11-14'); // no zone known: UTC
    expect(civilToday('Not/AZone', t)).toBe('2026-11-14'); // an invalid zone never throws
  });
});

describe('monthToDate — the default report window', () => {
  it('runs from the first of the month to today (civil dates, no timezone maths)', () => {
    expect(monthToDate('2026-11-14')).toEqual({ from: '2026-11-01', to: '2026-11-14' });
    expect(monthToDate('2026-01-01')).toEqual({ from: '2026-01-01', to: '2026-01-01' });
  });
});

describe('parseCivilPeriod — what the form may send (the API validates again)', () => {
  it('accepts a real, ordered YYYY-MM-DD range', () => {
    expect(parseCivilPeriod('2026-11-01', '2026-11-14')).toEqual({
      ok: true,
      from: '2026-11-01',
      to: '2026-11-14',
    });
    expect(parseCivilPeriod('2026-02-28', '2026-02-28').ok).toBe(true);
  });

  it('refuses impossible dates, wrong formats and a reversed range', () => {
    for (const [f, t] of [
      ['2026-02-30', '2026-03-01'],
      ['2026-13-01', '2026-13-02'],
      ['01/11/2026', '14/11/2026'],
      ['2026-11-1', '2026-11-14'],
      ['', '2026-11-14'],
      ['2026-11-14', '2026-11-01'],
    ] as const) {
      expect(parseCivilPeriod(f, t).ok, `${f}..${t}`).toBe(false);
    }
  });
});

describe('percentOfTotal — exact integer share, one decimal, no floats of money', () => {
  it('computes a share of the total from minor-unit strings', () => {
    expect(percentOfTotal('2500', '10000')).toBe('25.0');
    expect(percentOfTotal('1', '3')).toBe('33.3');
    expect(percentOfTotal('0', '0')).toBe('0.0');
    expect(percentOfTotal('10000', '10000')).toBe('100.0');
  });
});
