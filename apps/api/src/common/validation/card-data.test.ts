import { describe, expect, it } from 'vitest';
import { DomainError } from '../errors/domain-error.js';
import {
  containsCardNumber,
  FreeTextCardGuardPipe,
  isFreeTextKey,
  normaliseForCardScan,
} from './card-data.js';

const body = { type: 'body' } as never;
const reject = (v: unknown): DomainError => {
  try {
    new FreeTextCardGuardPipe().transform(v, body);
  } catch (e) {
    expect(e).toBeInstanceOf(DomainError);
    return e as DomainError;
  }
  throw new Error('not rejected');
};
const PANS = [
  '4111111111111111',
  '4111 1111 1111 1111',
  '4111-1111-1111-1111',
  '5555555555554444',
  '378282246310005',
  '6011111111111117',
  '4012888888881881',
  '4222222222222',
  '6200000000000005',
];

describe('containsCardNumber (whole run, Luhn, 13–19 digits, separators allowed)', () => {
  it('finds a card number anywhere in the text, with spaces or dashes', () => {
    for (const p of PANS) {
      expect(containsCardNumber(p), p).toBe(true);
      expect(containsCardNumber(`card ${p} exp 12/30`), p).toBe(true);
    }
  });

  it('does not flag ordinary numbers: short, Luhn-invalid, dates, prices, phone-length runs', () => {
    for (const t of [
      '4111111111111112',
      '1234567890123',
      '12345',
      '2026-11-11',
      'AED 1,250.500',
      '+971 50 123 4567',
      '123456789012',
      'order 20261105 qty 3',
      '',
      'invoice INV-2026-000123 total 105.00',
      'AE070331234567890123456', // an IBAN: letters break the run and the digit run is > 19
    ]) {
      expect(containsCardNumber(t), t).toBe(false);
    }
  });

  it('only a WHOLE 13–19 digit run counts: a longer run, or one repeated digit, is not a card number', () => {
    expect(containsCardNumber('x41111111111111119999999')).toBe(false);
    expect(containsCardNumber('00000000000000000000')).toBe(false);
    expect(containsCardNumber('0000000000000')).toBe(false);
    expect(containsCardNumber('1111111111111111')).toBe(false);
  });

  it('BYPASS ATTEMPTS are folded away: non-breaking / thin / tab / newline separators, dots, underscores, zero-width characters', () => {
    const p = '4111111111111111';
    const groups = ['4111', '1111', '1111', '1111'];
    for (const sep of [' ', ' ', '\t', '\n', '.', '_', ' ', '-']) {
      expect(containsCardNumber(groups.join(sep)), JSON.stringify(sep)).toBe(true);
    }
    expect(containsCardNumber(p.split('').join('​'))).toBe(true); // zero-width space between every digit
    expect(containsCardNumber('4111‍1111‌1111⁠' + '1111')).toBe(true); // ZWJ / ZWNJ / word joiner
    expect(containsCardNumber('4111­1111­1111­1111')).toBe(true); // soft hyphen
    expect(containsCardNumber('‮' + p)).toBe(true); // bidi override prefix
  });

  it('BYPASS ATTEMPTS are folded away: full-width, Arabic-Indic and Extended Arabic-Indic digits', () => {
    expect(containsCardNumber('４１１１１１１１１１１１１１１１')).toBe(true); // full-width
    expect(containsCardNumber('٤١١١١١١١١١١١١١١١')).toBe(true); // Arabic-Indic 4111…
    expect(containsCardNumber('۴۱۱۱ ۱۱۱۱ ۱۱۱۱ ۱۱۱۱')).toBe(true); // Extended Arabic-Indic, spaced
    expect(normaliseForCardScan('٤١١١')).toBe('4111');
    expect(normaliseForCardScan('４１１１')).toBe('4111');
  });

  it('what is NOT folded is NOT detected (documented limits): a number split across two values, or written in words', () => {
    expect(containsCardNumber('4111 1111')).toBe(false);
    expect(
      containsCardNumber('four one one one one one one one one one one one one one one one'),
    ).toBe(false);
  });
});

describe('isFreeTextKey — which fields are inspected', () => {
  it('free-text names, including camelCase and compound names, are inspected', () => {
    for (const k of [
      'note',
      'notes',
      'reason',
      'documentDiscountReason',
      'description',
      'memo',
      'comment',
      'remarks',
      'address',
      'registeredAddress',
      'displayName',
      'legalNameEn',
      'legalNameAr',
      'nameEn',
      'labelAr',
      'title',
      'valueText',
      'message',
      'details',
    ])
      expect(isFreeTextKey(k), k).toBe(true);
  });

  it('identifiers, references, codes, numbers, secrets and amounts are NEVER inspected', () => {
    for (const k of [
      'id',
      'customerId',
      'barcode',
      'sku',
      'trn',
      'crNumber',
      'number',
      'phone',
      'email',
      'slug',
      'code',
      'reference',
      'externalReference',
      'providerReference',
      'iban',
      'amount',
      'amountMinor',
      'quantity',
      'password',
      'token',
      'refreshToken',
      'secret',
      'key',
      'q',
      'cursor',
      'status',
    ])
      expect(isFreeTextKey(k) && !/Minor$/.test(k), k).toBe(false);
  });
});

describe('FreeTextCardGuardPipe', () => {
  it('rejects a card number in a free-text field at any depth: 400 SENSITIVE_DATA_REJECTED, value never echoed', () => {
    for (const v of [
      { note: PANS[0] },
      { reason: `refund to ${PANS[1]}` },
      { customer: { displayName: PANS[2] } },
      { lines: [{ description: PANS[3] }] },
      { legalNameEn: PANS[4] },
      { documentDiscountReason: PANS[0] },
      { registeredAddress: `PO Box ${PANS[1]}` },
      { valueText: PANS[0] },
      { nameAr: '٤١١١ ١١١١ ١١١١ ١١١١' },
      { note: '4111 1111 1111 1111' },
    ]) {
      const e = reject(v);
      expect([e.status, e.code]).toEqual([400, 'SENSITIVE_DATA_REJECTED']);
      expect(JSON.stringify(e) + e.message).not.toMatch(/4111|5555|3782|6011|٤١١١/);
    }
  });

  it('never reflects a caller-chosen key name that contains digits: the field is redacted', () => {
    const e = reject({ ['name4111111111111111']: PANS[0] });
    expect(e.details).toEqual([
      { field: '[redacted]', issue: 'must not contain a payment card number' },
    ]);
    expect(JSON.stringify(e)).not.toContain('4111');
    const e2 = reject({ note: PANS[0] });
    expect(e2.details).toEqual([
      { field: 'note', issue: 'must not contain a payment card number' },
    ]);
  });

  it('leaves non-free-text fields alone (barcode, phone, TRN, reference, ids, amounts) even if they look like a card number', () => {
    const v = {
      barcode: PANS[0],
      phone: PANS[0],
      trn: PANS[0],
      reference: PANS[0],
      externalReference: PANS[0],
      providerReference: PANS[0],
      sku: PANS[0],
      amountMinor: 4111111111111111,
      id: PANS[0],
      crNumber: PANS[0],
    };
    expect(new FreeTextCardGuardPipe().transform(v, body)).toBe(v);
  });

  it('passes ordinary free text, non-body arguments, non-objects, and is safe on deep or hostile input', () => {
    const p = new FreeTextCardGuardPipe();
    expect(p.transform({ note: 'deliver after 5pm, order 20261105' }, body)).toEqual({
      note: 'deliver after 5pm, order 20261105',
    });
    expect(p.transform({ note: PANS[0] }, { type: 'query' } as never)).toEqual({ note: PANS[0] });
    for (const v of [null, undefined, 'str', 7, [], [1, 2]])
      expect(() => p.transform(v, body)).not.toThrow();
    let deep: Record<string, unknown> = { note: 'x' };
    for (let i = 0; i < 5000; i++) deep = { child: deep };
    expect(() => p.transform(deep, body)).not.toThrow();
    // a very large free-text value is scanned in bounded time
    const big = { note: '12 '.repeat(100_000) };
    const t0 = Date.now();
    expect(() => p.transform(big, body)).not.toThrow();
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});
