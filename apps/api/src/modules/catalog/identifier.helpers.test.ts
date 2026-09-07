import { describe, expect, it } from 'vitest';
import {
  canonicalIdentifierValue,
  generateQrValue,
  isGeneratedQrValue,
} from './identifier.helpers.js';

const thrown = (fn: () => unknown): { code?: string; status?: number } | undefined => {
  try {
    fn();
    return undefined;
  } catch (e) {
    return e as { code?: string; status?: number };
  }
};

describe('identifier.helpers — canonicalIdentifierValue (task 3.5)', () => {
  it('SKU: trims + upper-cases; folds case-only differences; validates the grammar', () => {
    expect(canonicalIdentifierValue('SKU', '  rose-red.12 ')).toEqual({
      generateQr: false,
      value: 'ROSE-RED.12',
    });
    // "abc-1" and "ABC-1" canonicalise identically
    expect(canonicalIdentifierValue('SKU', 'abc-1')).toEqual(
      canonicalIdentifierValue('SKU', 'ABC-1'),
    );
    expect(thrown(() => canonicalIdentifierValue('SKU', 'has space'))?.code).toBe(
      'IDENTIFIER_SKU_INVALID',
    );
    expect(thrown(() => canonicalIdentifierValue('SKU', ''))?.code).toBe(
      'IDENTIFIER_VALUE_REQUIRED',
    );
    expect(thrown(() => canonicalIdentifierValue('SKU', undefined))?.code).toBe(
      'IDENTIFIER_VALUE_REQUIRED',
    );
  });

  it('BARCODE: trimmed but NEVER case-folded; rejects control chars + over-length', () => {
    expect(canonicalIdentifierValue('BARCODE', '  5901234123457 ')).toEqual({
      generateQr: false,
      value: '5901234123457',
    });
    expect(canonicalIdentifierValue('BARCODE', 'aB-cD_12')).toEqual({
      generateQr: false,
      value: 'aB-cD_12', // case preserved
    });
    expect(thrown(() => canonicalIdentifierValue('BARCODE', 'x\ty'))?.code).toBe(
      'IDENTIFIER_BARCODE_INVALID',
    );
    expect(thrown(() => canonicalIdentifierValue('BARCODE', 'x'.repeat(129)))?.code).toBe(
      'IDENTIFIER_BARCODE_INVALID',
    );
    expect(thrown(() => canonicalIdentifierValue('BARCODE', '   '))?.code).toBe(
      'IDENTIFIER_VALUE_REQUIRED',
    );
  });

  it('QR: a client value is rejected; the server generates an opaque token', () => {
    expect(canonicalIdentifierValue('QR', undefined)).toEqual({ generateQr: true });
    expect(canonicalIdentifierValue('QR', '')).toEqual({ generateQr: true });
    expect(thrown(() => canonicalIdentifierValue('QR', 'MY-QR'))?.code).toBe(
      'IDENTIFIER_QR_VALUE_NOT_ALLOWED',
    );
  });
});

describe('identifier.helpers — generateQrValue', () => {
  it('mints a 40-hex-char opaque token that round-trips isGeneratedQrValue', () => {
    const values = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const v = generateQrValue();
      expect(v).toMatch(/^[0-9A-F]{40}$/);
      expect(isGeneratedQrValue(v)).toBe(true);
      values.add(v);
    }
    expect(values.size).toBe(200); // no collisions across 200 draws
  });
});
