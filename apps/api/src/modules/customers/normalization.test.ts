import { describe, expect, it } from 'vitest';
import { normalizePhoneE164, normalizeEmail } from './normalization.js';

describe('normalizePhoneE164 (task 3b.2)', () => {
  it('parses a + international number without needing a region', () => {
    expect(normalizePhoneE164('+971501234567', null)).toBe('+971501234567');
  });

  it('parses national-format input using Company.countryCode as region (AE)', () => {
    expect(normalizePhoneE164('0501234567', 'AE')).toBe('+971501234567');
  });

  it('parses national-format input using Company.countryCode as region — a non-AE company (KW), proving the region is genuinely parameterized, not hardcoded (§6)', () => {
    expect(normalizePhoneE164('50123456', 'KW')).toBe('+96550123456');
  });

  it('national-format input with no usable Company country fails deterministically', () => {
    expect(() => normalizePhoneE164('0501234567', null)).toThrow(
      expect.objectContaining({ code: 'CUSTOMER_PHONE_INVALID' }),
    );
  });

  it('never falls back to a default region (e.g. an invalid country code is not silently treated as AE)', () => {
    expect(() => normalizePhoneE164('0501234567', 'ZZ')).toThrow(
      expect.objectContaining({ code: 'CUSTOMER_PHONE_INVALID' }),
    );
  });

  it('an invalid/unparseable phone number is rejected deterministically', () => {
    expect(() => normalizePhoneE164('not-a-phone', 'AE')).toThrow(
      expect.objectContaining({ code: 'CUSTOMER_PHONE_INVALID' }),
    );
  });

  it('an absent phone returns null, never throws', () => {
    expect(normalizePhoneE164(null, null)).toBeNull();
    expect(normalizePhoneE164(undefined, null)).toBeNull();
    expect(normalizePhoneE164('', 'AE')).toBeNull();
    expect(normalizePhoneE164('   ', 'AE')).toBeNull();
  });

  it('never references Branch timezone, accountingTimezone, or a locale fallback (structural, code only — not doc comments)', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync(new URL('./normalization.ts', import.meta.url), 'utf8');
    // strip block (/** ... */) and line (//...) comments before scanning —
    // this file's own doc comment explicitly NAMES these anti-patterns to
    // disclaim them, which would otherwise false-positive a naive scan.
    const codeOnly = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(
      /branch\s*\.\s*timezone|accountingTimezone|browser|navigator\.language|['"]AE['"]|['"]UAE['"]/i.test(
        codeOnly,
      ),
    ).toBe(false);
  });
});

describe('normalizeEmail (task 3b.2)', () => {
  it('trims and lowercases', () => {
    expect(normalizeEmail('  Some.User+Tag@Example.COM  ')).toBe('some.user+tag@example.com');
  });

  it('does not strip dots or +tags (no provider-specific rewriting)', () => {
    expect(normalizeEmail('a.b+tag@example.com')).toBe('a.b+tag@example.com');
  });

  it('an absent email returns null, never throws', () => {
    expect(normalizeEmail(null)).toBeNull();
    expect(normalizeEmail(undefined)).toBeNull();
    expect(normalizeEmail('')).toBeNull();
  });
});
