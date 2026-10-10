import { describe, expect, it } from 'vitest';
import { DomainError } from '../../common/errors/domain-error.js';
import {
  minorUnitsToWire,
  parseMinorUnitsText,
  resolveCompanyReportAuthority,
} from './report-money.js';

describe('resolveCompanyReportAuthority — the company is the currency + timezone authority', () => {
  it('AED is a 2-decimal currency in the Dubai accounting timezone', () => {
    expect(
      resolveCompanyReportAuthority({
        defaultCurrency: 'AED',
        accountingTimezone: 'Asia/Dubai',
      }),
    ).toEqual({ currencyCode: 'AED', currencyExponent: 2, accountingTimezone: 'Asia/Dubai' });
  });

  it.each(['KWD', 'BHD', 'OMR'])('%s is a 3-decimal currency (frozen money registry)', (code) => {
    expect(
      resolveCompanyReportAuthority({ defaultCurrency: code, accountingTimezone: 'Asia/Kuwait' })
        .currencyExponent,
    ).toBe(3);
  });

  it.each([
    ['no currency', { defaultCurrency: null, accountingTimezone: 'Asia/Dubai' }],
    ['an empty currency', { defaultCurrency: '', accountingTimezone: 'Asia/Dubai' }],
    ['an unknown currency', { defaultCurrency: 'ZZZ', accountingTimezone: 'Asia/Dubai' }],
    ['no timezone', { defaultCurrency: 'AED', accountingTimezone: null }],
    ['an empty timezone', { defaultCurrency: 'AED', accountingTimezone: '' }],
    ['an invalid timezone', { defaultCurrency: 'AED', accountingTimezone: 'Mars/Olympus' }],
  ])('FAILS CLOSED (409 REPORT_COMPANY_NOT_CONFIGURED) with %s', (_name, row) => {
    try {
      resolveCompanyReportAuthority(row);
      throw new Error('expected a DomainError');
    } catch (e) {
      expect(e).toBeInstanceOf(DomainError);
      expect((e as DomainError).code).toBe('REPORT_COMPANY_NOT_CONFIGURED');
      expect((e as DomainError).status).toBe(409);
    }
  });
});

describe('exact minor-unit text', () => {
  it('parses a database integer text to a bigint, exactly — beyond Number.MAX_SAFE_INTEGER', () => {
    expect(parseMinorUnitsText('0', 'x')).toBe(0n);
    expect(parseMinorUnitsText('12345', 'x')).toBe(12345n);
    expect(parseMinorUnitsText('-7', 'x')).toBe(-7n);
    const huge = '9223372036854775807000';
    expect(parseMinorUnitsText(huge, 'x')).toBe(9223372036854775807000n);
    expect(minorUnitsToWire(parseMinorUnitsText(huge, 'x'))).toBe(huge);
  });

  it.each([
    ['a decimal point', '12.50'],
    ['an exponent', '1e3'],
    ['whitespace', ' 12'],
    ['a plus sign', '+12'],
    ['an empty string', ''],
    ['a hex literal', '0x10'],
    ['a JS number', 12],
    ['a bigint (never silently coerced)', 12n],
    ['null', null],
  ])('rejects %s — a float or a non-text value never becomes a figure', (_n, bad) => {
    expect(() => parseMinorUnitsText(bad, 'x')).toThrow(RangeError);
  });

  it('serializes a bigint as a plain decimal string (no number conversion, no exponent)', () => {
    expect(minorUnitsToWire(0n)).toBe('0');
    expect(minorUnitsToWire(1_000_000_000_000_000_000_000n)).toBe('1000000000000000000000');
    expect(minorUnitsToWire(-5n)).toBe('-5');
  });
});
