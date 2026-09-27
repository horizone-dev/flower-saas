import { describe, expect, it } from 'vitest';
import {
  computeInvoiceCoverage,
  canTransitionInvoicePaymentStatus,
  assertInvoicePaymentStatusTransition,
  INVOICE_PAYMENT_STATUSES_3B6,
  type InvoicePaymentStatus3b6,
} from './invoice-payment-status.js';

describe('computeInvoiceCoverage (3b.6 Checkpoint A)', () => {
  it('zero coverage -> UNPAID', () => {
    const r = computeInvoiceCoverage({
      invoiceTotalMinor: 500n,
      paymentAllocatedMinor: 0n,
      advanceAppliedMinor: 0n,
    });
    expect(r).toEqual({ outstandingMinor: 500n, coverageMinor: 0n, status: 'UNPAID' });
  });

  it('partial coverage -> PARTIAL', () => {
    const r = computeInvoiceCoverage({
      invoiceTotalMinor: 500n,
      paymentAllocatedMinor: 200n,
      advanceAppliedMinor: 0n,
    });
    expect(r).toEqual({ outstandingMinor: 300n, coverageMinor: 200n, status: 'PARTIAL' });
  });

  it('full coverage via PaymentAllocation alone -> PAID', () => {
    const r = computeInvoiceCoverage({
      invoiceTotalMinor: 500n,
      paymentAllocatedMinor: 500n,
      advanceAppliedMinor: 0n,
    });
    expect(r).toEqual({ outstandingMinor: 0n, coverageMinor: 500n, status: 'PAID' });
  });

  it('full coverage via combined Payment + Advance application -> PAID', () => {
    const r = computeInvoiceCoverage({
      invoiceTotalMinor: 500n,
      paymentAllocatedMinor: 300n,
      advanceAppliedMinor: 200n,
    });
    expect(r).toEqual({ outstandingMinor: 0n, coverageMinor: 500n, status: 'PAID' });
  });

  it('walk-in invoice: advanceAppliedMinor is structurally 0, formula still holds', () => {
    const r = computeInvoiceCoverage({
      invoiceTotalMinor: 100n,
      paymentAllocatedMinor: 40n,
      advanceAppliedMinor: 0n,
    });
    expect(r.status).toBe('PARTIAL');
    expect(r.outstandingMinor).toBe(60n);
  });

  it('rejects coverage exceeding invoice total', () => {
    expect(() =>
      computeInvoiceCoverage({
        invoiceTotalMinor: 100n,
        paymentAllocatedMinor: 60n,
        advanceAppliedMinor: 60n,
      }),
    ).toThrow(RangeError);
  });

  it('rejects negative inputs', () => {
    expect(() =>
      computeInvoiceCoverage({
        invoiceTotalMinor: 100n,
        paymentAllocatedMinor: -1n,
        advanceAppliedMinor: 0n,
      }),
    ).toThrow(RangeError);
    expect(() =>
      computeInvoiceCoverage({
        invoiceTotalMinor: -1n,
        paymentAllocatedMinor: 0n,
        advanceAppliedMinor: 0n,
      }),
    ).toThrow(RangeError);
  });

  it('zero-total invoice with zero coverage is UNPAID, not PAID (0==0 falls to the UNPAID branch first)', () => {
    const r = computeInvoiceCoverage({
      invoiceTotalMinor: 0n,
      paymentAllocatedMinor: 0n,
      advanceAppliedMinor: 0n,
    });
    expect(r.status).toBe('UNPAID');
  });
});

describe('invoice payment-status transition graph (3b.6 Checkpoint A)', () => {
  const allowed: Array<[InvoicePaymentStatus3b6, InvoicePaymentStatus3b6]> = [
    ['UNPAID', 'UNPAID'],
    ['UNPAID', 'PARTIAL'],
    ['UNPAID', 'PAID'],
    ['PARTIAL', 'PARTIAL'],
    ['PARTIAL', 'PAID'],
    ['PAID', 'PAID'],
  ];
  for (const [from, to] of allowed) {
    it(`allows ${from} -> ${to}`, () => {
      expect(canTransitionInvoicePaymentStatus(from, to)).toBe(true);
      expect(() => assertInvoicePaymentStatusTransition(from, to)).not.toThrow();
    });
  }

  const forbidden: Array<[InvoicePaymentStatus3b6, InvoicePaymentStatus3b6]> = [
    ['PARTIAL', 'UNPAID'],
    ['PAID', 'PARTIAL'],
    ['PAID', 'UNPAID'],
  ];
  for (const [from, to] of forbidden) {
    it(`rejects ${from} -> ${to} (backward transition)`, () => {
      expect(canTransitionInvoicePaymentStatus(from, to)).toBe(false);
      expect(() => assertInvoicePaymentStatusTransition(from, to)).toThrow(RangeError);
    });
  }

  it('never produces SETTLED/PARTIALLY_REFUNDED/REFUNDED/CANCELLED/VOID — the type itself excludes them', () => {
    expect(INVOICE_PAYMENT_STATUSES_3B6).toEqual(['UNPAID', 'PARTIAL', 'PAID']);
    expect(INVOICE_PAYMENT_STATUSES_3B6).not.toContain('SETTLED');
    expect(INVOICE_PAYMENT_STATUSES_3B6).not.toContain('PARTIALLY_REFUNDED');
    expect(INVOICE_PAYMENT_STATUSES_3B6).not.toContain('REFUNDED');
    expect(INVOICE_PAYMENT_STATUSES_3B6).not.toContain('CANCELLED');
    expect(INVOICE_PAYMENT_STATUSES_3B6).not.toContain('VOID');
  });
});
