import { describe, expect, it } from 'vitest';
import { assertCustomerReceivableSourceShape } from './customer-receivable-source.js';

describe('assertCustomerReceivableSourceShape (3b.6 Checkpoint A)', () => {
  it('accepts a valid INVOICE source', () => {
    expect(() =>
      assertCustomerReceivableSourceShape({
        sourceType: 'INVOICE',
        invoiceId: 'inv-1',
        creditAuthorized: true,
      }),
    ).not.toThrow();
  });

  it('rejects an INVOICE source with no invoiceId', () => {
    expect(() =>
      assertCustomerReceivableSourceShape({
        sourceType: 'INVOICE',
        invoiceId: '',
        creditAuthorized: false,
      }),
    ).toThrow(RangeError);
  });

  it('rejects an INVOICE source that independently authors a principal amount', () => {
    expect(() =>
      assertCustomerReceivableSourceShape({
        sourceType: 'INVOICE',
        invoiceId: 'inv-1',
        creditAuthorized: true,
        // @ts-expect-error — deliberately smuggling a field this sourceType must never carry
        originalAmountMinor: 500n,
      }),
    ).toThrow(RangeError);
  });

  it('accepts a valid OPENING source', () => {
    expect(() =>
      assertCustomerReceivableSourceShape({
        sourceType: 'OPENING',
        originalAmountMinor: 500n,
        currencyCode: 'AED',
        currencyExponent: 2,
        branchId: 'branch-1',
      }),
    ).not.toThrow();
  });

  it('rejects an OPENING source carrying an invoiceId', () => {
    expect(() =>
      assertCustomerReceivableSourceShape({
        sourceType: 'OPENING',
        originalAmountMinor: 500n,
        currencyCode: 'AED',
        currencyExponent: 2,
        branchId: 'branch-1',
        // @ts-expect-error — deliberately smuggling a field this sourceType must never carry
        invoiceId: 'inv-1',
      }),
    ).toThrow(RangeError);
  });

  it('rejects an OPENING source with a negative principal', () => {
    expect(() =>
      assertCustomerReceivableSourceShape({
        sourceType: 'OPENING',
        originalAmountMinor: -1n,
        currencyCode: 'AED',
        currencyExponent: 2,
        branchId: 'branch-1',
      }),
    ).toThrow(RangeError);
  });

  it('rejects an OPENING source with no currencyCode', () => {
    expect(() =>
      assertCustomerReceivableSourceShape({
        sourceType: 'OPENING',
        originalAmountMinor: 100n,
        currencyCode: '',
        currencyExponent: 2,
        branchId: 'branch-1',
      }),
    ).toThrow(RangeError);
  });

  it('rejects an OPENING source with a negative or non-integer currencyExponent', () => {
    expect(() =>
      assertCustomerReceivableSourceShape({
        sourceType: 'OPENING',
        originalAmountMinor: 100n,
        currencyCode: 'AED',
        currencyExponent: -1,
        branchId: 'branch-1',
      }),
    ).toThrow(RangeError);
    expect(() =>
      assertCustomerReceivableSourceShape({
        sourceType: 'OPENING',
        originalAmountMinor: 100n,
        currencyCode: 'AED',
        currencyExponent: 2.5,
        branchId: 'branch-1',
      }),
    ).toThrow(RangeError);
  });

  it('rejects an OPENING source with no branchId — opening balances are branch-scoped, never ambiguous', () => {
    expect(() =>
      assertCustomerReceivableSourceShape({
        sourceType: 'OPENING',
        originalAmountMinor: 100n,
        currencyCode: 'AED',
        currencyExponent: 2,
        branchId: '',
      }),
    ).toThrow(RangeError);
  });
});
