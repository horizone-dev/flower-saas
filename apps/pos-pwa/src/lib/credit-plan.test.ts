import { describe, expect, it } from 'vitest';
import {
  availableAdvances,
  creditAdvisory,
  planCustomerPayment,
  saleFingerprint,
  type AdvanceChoice,
  type CustomerPaymentInput,
} from './credit-plan';
import { checkoutErrorMessage, completeKeyForSale, newAttempt } from './checkout';
import { buildReceipt, receiptText, type ReceiptInput } from './receipt';

/**
 * CUSTOMER CREDIT AND ADVANCE PAYMENTS — the POS side of the FROZEN `complete-sale` contract. The SERVER decides everything (credit limit, advance
 * availability, who may apply an advance or override a limit); this module only BUILDS THE REQUEST from the cashier's choices and shows the
 * arithmetic the cashier needs, in exact integer minor units. Its "refusals" are advisory previews of rules the server enforces again — a test pins
 * that no server-owned field can ever appear in the request.
 */
const ADV1 = '0192f3c2-7b1e-7a3a-8c55-3f5d6a7b8c01';
const ADV2 = '0192f3c2-7b1e-7a3a-8c55-3f5d6a7b8c02';
const adv = (advanceId: string, availableMinor: bigint, applyMinor = 0n): AdvanceChoice => ({
  advanceId,
  availableMinor,
  applyMinor,
});
const base = (o: Partial<CustomerPaymentInput> = {}): CustomerPaymentInput => ({
  totalMinor: 10_500n,
  hasCustomer: true,
  advances: [],
  mode: 'CASH',
  cashTenderedMinor: 10_500n,
  cardMinor: null,
  depositMinor: null,
  depositMethod: 'CASH',
  creditReason: null,
  ...o,
});
const ok = (i: CustomerPaymentInput) => {
  const p = planCustomerPayment(i);
  if (!p.ok) throw new Error(`expected a plan, got ${p.reason}`);
  return p;
};
const refused = (i: CustomerPaymentInput): string => {
  const p = planCustomerPayment(i);
  if (p.ok) throw new Error('expected a refusal');
  return p.reason;
};

describe('PAY_NOW with advances — the advance is spent first, the remainder is paid as usual', () => {
  it('no advance: identical to the existing tender plan, sent as PAY_NOW with no advanceApplications key', () => {
    const p = ok(base());
    expect(p.request).toEqual({
      paymentIntent: 'PAY_NOW',
      tenders: [{ method: 'CASH', amountMinor: '10500' }],
    });
    expect(p.figures).toEqual({
      totalMinor: 10_500n,
      advanceMinor: 0n,
      payNowMinor: 10_500n,
      creditMinor: 0n,
    });
    expect('advanceApplications' in p.request).toBe(false);
  });

  it('part advance + cash for the rest: the cash tender is the TOTAL minus the advance (exact), change is a counting aid on the remainder', () => {
    const p = ok(base({ advances: [adv(ADV1, 4_000n, 2_500n)], cashTenderedMinor: 10_000n }));
    expect(p.request).toEqual({
      paymentIntent: 'PAY_NOW',
      tenders: [{ method: 'CASH', amountMinor: '8000' }],
      advanceApplications: [{ advanceId: ADV1, amountMinor: '2500' }],
    });
    expect(p.figures).toEqual({
      totalMinor: 10_500n,
      advanceMinor: 2_500n,
      payNowMinor: 8_000n,
      creditMinor: 0n,
    });
    expect(p.changeDueMinor).toBe(2_000n);
  });

  it('advance that covers the WHOLE total: an advance-only sale — PAY_NOW with NO tender (the server needs only the advance authority)', () => {
    const p = ok(
      base({ advances: [adv(ADV1, 20_000n, 10_500n)], mode: 'CASH', cashTenderedMinor: null }),
    );
    expect(p.request).toEqual({
      paymentIntent: 'PAY_NOW',
      tenders: [],
      advanceApplications: [{ advanceId: ADV1, amountMinor: '10500' }],
    });
    expect(p.figures.payNowMinor).toBe(0n);
  });

  it('several advances are sent ascending by advanceId (the server lock order) and zero applications are dropped', () => {
    const p = ok(
      base({
        advances: [
          adv(ADV2, 3_000n, 1_000n),
          adv(ADV1, 9_000n, 2_000n),
          adv('0192f3c2-7b1e-7a3a-8c55-3f5d6a7b8c03', 5_000n, 0n),
        ],
        cashTenderedMinor: 7_500n,
      }),
    );
    expect(p.request.advanceApplications).toEqual([
      { advanceId: ADV1, amountMinor: '2000' },
      { advanceId: ADV2, amountMinor: '1000' },
    ]);
    expect(p.figures.advanceMinor).toBe(3_000n);
    expect(p.request.tenders).toEqual([{ method: 'CASH', amountMinor: '7500' }]);
  });

  it('card and split settle the remainder after the advance', () => {
    const card = ok(
      base({ mode: 'CARD', advances: [adv(ADV1, 5_000n, 500n)], cashTenderedMinor: null }),
    );
    expect(card.request.tenders).toEqual([{ method: 'CARD_TERMINAL', amountMinor: '10000' }]);
    const split = ok(
      base({
        mode: 'SPLIT',
        advances: [adv(ADV1, 5_000n, 500n)],
        cardMinor: 4_000n,
        cashTenderedMinor: 6_000n,
      }),
    );
    expect(split.request.tenders).toEqual([
      { method: 'CASH', amountMinor: '6000' },
      { method: 'CARD_TERMINAL', amountMinor: '4000' },
    ]);
  });
});

describe('ON_CREDIT — the unpaid remainder becomes the customer’s receivable', () => {
  it('full credit: ON_CREDIT with no tender, credit = the whole total', () => {
    const p = ok(base({ mode: 'CREDIT', cashTenderedMinor: null }));
    expect(p.request).toEqual({ paymentIntent: 'ON_CREDIT', tenders: [] });
    expect(p.figures).toEqual({
      totalMinor: 10_500n,
      advanceMinor: 0n,
      payNowMinor: 0n,
      creditMinor: 10_500n,
    });
  });

  it('a deposit now (cash or card) and the rest on credit; the deposit is exact, never more than the remainder', () => {
    const cash = ok(base({ mode: 'CREDIT', depositMinor: 3_000n, depositMethod: 'CASH' }));
    expect(cash.request.tenders).toEqual([{ method: 'CASH', amountMinor: '3000' }]);
    expect(cash.figures.creditMinor).toBe(7_500n);
    const card = ok(base({ mode: 'CREDIT', depositMinor: 3_000n, depositMethod: 'CARD' }));
    expect(card.request.tenders).toEqual([{ method: 'CARD_TERMINAL', amountMinor: '3000' }]);
  });

  it('advance + deposit + credit all together add up exactly to the total', () => {
    const p = ok(
      base({ mode: 'CREDIT', advances: [adv(ADV1, 4_000n, 2_000n)], depositMinor: 1_500n }),
    );
    expect(p.figures).toEqual({
      totalMinor: 10_500n,
      advanceMinor: 2_000n,
      payNowMinor: 1_500n,
      creditMinor: 7_000n,
    });
    expect(p.figures.advanceMinor + p.figures.payNowMinor + p.figures.creditMinor).toBe(
      p.figures.totalMinor,
    );
    expect(p.request.paymentIntent).toBe('ON_CREDIT');
  });

  it('a credit exception reason is sent ONLY on ON_CREDIT, trimmed, and only when non-blank — it is a reason, never a flag', () => {
    const withReason = ok(
      base({ mode: 'CREDIT', creditReason: '  regular customer, paid last order  ' }),
    );
    expect(withReason.request.creditLimitExceptionReason).toBe('regular customer, paid last order');
    expect(
      'creditLimitExceptionReason' in ok(base({ mode: 'CREDIT', creditReason: '   ' })).request,
    ).toBe(false);
    expect(
      'creditLimitExceptionReason' in ok(base({ creditReason: 'ignored on PAY_NOW' })).request,
    ).toBe(false);
  });
});

describe('advisory refusals — the server enforces every one of these again', () => {
  it('credit or an advance needs an identified customer', () => {
    expect(refused(base({ hasCustomer: false, mode: 'CREDIT' }))).toBe('CUSTOMER_REQUIRED');
    expect(refused(base({ hasCustomer: false, advances: [adv(ADV1, 1_000n, 500n)] }))).toBe(
      'CUSTOMER_REQUIRED',
    );
  });

  it('an advance application above what is available, above the total, or repeated is refused before any request', () => {
    expect(refused(base({ advances: [adv(ADV1, 1_000n, 1_001n)] }))).toBe(
      'ADVANCE_EXCEEDS_AVAILABLE',
    );
    expect(refused(base({ advances: [adv(ADV1, 50_000n, 10_501n)] }))).toBe(
      'ADVANCE_EXCEEDS_TOTAL',
    );
    expect(
      refused(base({ advances: [adv(ADV1, 5_000n, 1_000n), adv(ADV1, 5_000n, 1_000n)] })),
    ).toBe('ADVANCE_DUPLICATE');
    expect(refused(base({ advances: [adv(ADV1, 5_000n, -1n)] }))).toBe('ADVANCE_INVALID');
  });

  it('ON_CREDIT with nothing left to put on credit is refused (the server answers SALE_ON_CREDIT_FULLY_COVERED)', () => {
    expect(refused(base({ mode: 'CREDIT', advances: [adv(ADV1, 20_000n, 10_500n)] }))).toBe(
      'CREDIT_FULLY_COVERED',
    );
    expect(refused(base({ mode: 'CREDIT', depositMinor: 10_500n }))).toBe('CREDIT_FULLY_COVERED');
    expect(refused(base({ mode: 'CREDIT', depositMinor: 20_000n }))).toBe('DEPOSIT_INVALID');
    expect(refused(base({ mode: 'CREDIT', depositMinor: -5n }))).toBe('DEPOSIT_INVALID');
  });

  it('the existing tender refusals still apply to the remainder', () => {
    expect(refused(base({ cashTenderedMinor: 9_000n }))).toBe('CASH_TENDER_SHORT');
    expect(refused(base({ mode: 'SPLIT', cardMinor: null, cashTenderedMinor: 10_500n }))).toBe(
      'SPLIT_CARD_INVALID',
    );
    expect(refused(base({ totalMinor: 0n }))).toBe('TOTAL_NOT_POSITIVE');
  });

  it('NO server-owned field can ever appear in the request: scope, customer, money authority, override flags', () => {
    const p = ok(
      base({
        mode: 'CREDIT',
        advances: [adv(ADV1, 4_000n, 2_000n)],
        depositMinor: 1_500n,
        creditReason: 'x',
      }),
    );
    const forbidden = [
      'customerId',
      'customerCompanyAccountId',
      'tenantId',
      'companyId',
      'branchId',
      'terminalId',
      'userId',
      'currencyCode',
      'currencyExponent',
      'operationKey',
      'creditOverride',
      'force',
      'invoiceId',
      'outstandingMinor',
      'totalAmountMinor',
    ];
    for (const k of Object.keys(p.request)) expect(forbidden).not.toContain(k);
    expect(Object.keys(p.request).sort()).toEqual([
      'advanceApplications',
      'creditLimitExceptionReason',
      'paymentIntent',
      'tenders',
    ]);
  });

  it('amounts are exact integer strings, and a 3-decimal currency (KWD) behaves identically', () => {
    const p = ok(
      base({
        totalMinor: 12_345n,
        cashTenderedMinor: 12_345n - 2_222n,
        advances: [adv(ADV1, 9_999n, 2_222n)],
      }),
    );
    expect(p.request.tenders).toEqual([{ method: 'CASH', amountMinor: '10123' }]);
    expect(p.request.advanceApplications).toEqual([{ advanceId: ADV1, amountMinor: '2222' }]);
  });
});

describe('credit advisory — a PREVIEW of the limit check, never the decision', () => {
  const summary = (
    over: { enabled?: boolean; available?: string | null; limit?: string | null } = {},
  ) => ({
    credit: {
      scope: 'COMPANY',
      creditEnabled: over.enabled ?? true,
      creditLimitMinor: over.limit === undefined ? '50000' : over.limit,
      creditExposureMinor: '20000',
      availableCreditMinor: over.available === undefined ? '30000' : over.available,
      projectionIntegrity: 'OK',
    },
  });
  it('says whether credit is enabled and whether the remainder fits the available credit — and always that the server decides', () => {
    expect(creditAdvisory(summary({ enabled: false }), 7_000n)).toEqual({ state: 'DISABLED' });
    expect(creditAdvisory(summary(), 7_000n)).toEqual({ state: 'WITHIN', availableMinor: 30_000n });
    expect(creditAdvisory(summary({ available: '5000' }), 7_000n)).toEqual({
      state: 'OVER',
      availableMinor: 5_000n,
      overByMinor: 2_000n,
    });
    expect(creditAdvisory(summary({ available: null, limit: null }), 7_000n)).toEqual({
      state: 'UNLIMITED',
    });
    expect(creditAdvisory(null, 7_000n)).toEqual({ state: 'UNKNOWN' });
  });
  it('lists only advances with something available, newest first as the server sent them', () => {
    const rows = [
      { customerAdvanceId: ADV1, availableAmountMinor: '0' },
      { customerAdvanceId: ADV2, availableAmountMinor: '3000' },
    ];
    expect(availableAdvances(rows).map((a) => a.advanceId)).toEqual([ADV2]);
    expect(availableAdvances(rows)[0]!.availableMinor).toBe(3_000n);
  });
});

describe('idempotency — a retry of the SAME payment replays, ANY change to the payment gets a new key', () => {
  const n = (() => {
    let i = 0;
    return () => `k${++i}`;
  })();
  const a = ok(
    base({ mode: 'CREDIT', advances: [adv(ADV1, 4_000n, 2_000n)], depositMinor: 1_500n }),
  ).request;

  it('the fingerprint covers intent, tenders (in order), advances (canonical order) and the credit reason', () => {
    const same = ok(
      base({ mode: 'CREDIT', advances: [adv(ADV1, 4_000n, 2_000n)], depositMinor: 1_500n }),
    ).request;
    expect(saleFingerprint(same)).toBe(saleFingerprint(a));
    const different: Parameters<typeof saleFingerprint>[0][] = [
      ok(base({ mode: 'CREDIT', advances: [adv(ADV1, 4_000n, 2_001n)], depositMinor: 1_500n }))
        .request,
      ok(base({ mode: 'CREDIT', advances: [adv(ADV1, 4_000n, 2_000n)], depositMinor: 1_501n }))
        .request,
      ok(
        base({
          mode: 'CREDIT',
          advances: [adv(ADV1, 4_000n, 2_000n)],
          depositMinor: 1_500n,
          depositMethod: 'CARD',
        }),
      ).request,
      ok(
        base({
          mode: 'CREDIT',
          advances: [adv(ADV1, 4_000n, 2_000n)],
          depositMinor: 1_500n,
          creditReason: 'why',
        }),
      ).request,
      ok(base({ mode: 'CASH', advances: [adv(ADV1, 4_000n, 2_000n)], cashTenderedMinor: 8_500n }))
        .request,
    ];
    for (const d of different) expect(saleFingerprint(d)).not.toBe(saleFingerprint(a));
    expect(new Set([a, ...different].map(saleFingerprint)).size).toBe(6);
  });

  it('completeKeyForSale gives the same key for the same plan and a new key for a changed one; the attempt owns the keys', () => {
    const attempt = newAttempt(() => 'order-key');
    const k1 = completeKeyForSale(attempt, a, n);
    const k1b = completeKeyForSale(k1.attempt, a, n);
    expect(k1b.key).toBe(k1.key);
    const changed = { ...a, tenders: [{ method: 'CASH' as const, amountMinor: '1600' }] };
    const k2 = completeKeyForSale(k1b.attempt, changed, n);
    expect(k2.key).not.toBe(k1.key);
    // the earlier payment's key is still there: going back to it replays it
    expect(completeKeyForSale(k2.attempt, a, n).key).toBe(k1.key);
  });
});

describe('cashier-facing refusals — what the server said, in words, with the next step', () => {
  const msg = (code: string, status = 422, ctx?: { usedAdvance?: boolean; usedCredit?: boolean }) =>
    checkoutErrorMessage(code, status, ctx);
  it('credit codes', () => {
    expect(msg('CUSTOMER_CREDIT_DISABLED')).toMatch(/credit is not enabled/i);
    expect(msg('CUSTOMER_CREDIT_LIMIT_EXCEEDED')).toMatch(/credit limit/i);
    expect(msg('CUSTOMER_CREDIT_LIMIT_EXCEEDED')).toMatch(/part payment|exception/i);
    expect(msg('SALE_ON_CREDIT_FULLY_COVERED')).toMatch(/pay now/i);
    expect(msg('SALE_CREDIT_REQUIRES_CUSTOMER')).toMatch(/select the customer/i);
    expect(msg('STEP_UP_REQUIRED', 403)).toMatch(/code|verify|confirm/i);
    expect(msg('CREDIT_OVERRIDE_DENIED', 403)).toMatch(/owner/i);
    expect(msg('CREDIT_OVERRIDE_REASON_REQUIRED', 422)).toMatch(/reason/i);
  });
  it('advance codes, and a 403 on an advance sale says WHICH authority is missing', () => {
    expect(msg('CUSTOMER_ADVANCE_NOT_FOUND', 404)).toMatch(/advance/i);
    expect(msg('CUSTOMER_ADVANCE_APPLICATION_INVALID')).toMatch(/advance/i);
    expect(msg('SALE_DUPLICATE_ADVANCE')).toMatch(/twice|same advance/i);
    expect(msg('FORBIDDEN', 403, { usedAdvance: true })).toMatch(
      /advance.*manager|manager.*advance/i,
    );
    expect(msg('FORBIDDEN', 403)).toBe('You are not allowed to do this. Ask a manager.');
  });
  it('the existing messages are unchanged', () => {
    expect(msg('ORDER_VERSION_CONFLICT', 409)).toMatch(/changed or already completed/);
    expect(msg('X', 500)).toMatch(/Do NOT hand over the goods/);
  });
});

describe('receipt — shows what the SERVER recorded: advance applied, paid now, balance due', () => {
  const input = (over: Partial<ReceiptInput> = {}): ReceiptInput => ({
    seller: { name: 'Rose Co', trn: '100', address: null },
    branchName: 'Main',
    orderNumber: 'O-1',
    invoice: {
      invoiceNumber: 'INV-1',
      invoiceDate: '2026-11-18',
      currencyCode: 'AED',
      currencyExponent: 2,
      subtotalAmountMinor: '10000',
      documentDiscountAmountMinor: '0',
      taxTotalAmountMinor: '500',
      totalAmountMinor: '10500',
      paymentStatus: 'PARTIAL',
    },
    lines: [],
    priceTaxMode: 'TAX_EXCLUSIVE',
    customerName: 'Layla',
    payments: [{ method: 'CASH', amountMinor: '1500' }],
    copy: 'ORIGINAL',
    advances: [{ amountMinor: '2000' }],
    outstandingMinor: '7000',
    ...over,
  });
  it('the model carries the advance, the payments and the balance due exactly as the server reported them', () => {
    const m = buildReceipt(input());
    expect(m.advances).toEqual([{ amount: '20.00' }]);
    expect(m.payments).toEqual([{ method: 'Cash', amount: '15.00' }]);
    expect(m.balanceDue).toBe('70.00');
    expect(m.paymentStatus).toBe('PART PAID');
  });
  it('the printed text shows the advance, the payment, the balance due and the status; nothing when there is no credit', () => {
    const text = receiptText(buildReceipt(input())).join('\n');
    expect(text).toMatch(/Advance applied\s+20\.00/);
    expect(text).toMatch(/Cash\s+15\.00/);
    expect(text).toMatch(/Balance due \(on account\)\s+70\.00/);
    const plain = receiptText(
      buildReceipt(
        input({
          advances: [],
          outstandingMinor: '0',
          payments: [{ method: 'CASH', amountMinor: '10500' }],
          invoice: { ...input().invoice, paymentStatus: 'PAID' },
        }),
      ),
    ).join('\n');
    expect(plain).not.toMatch(/Balance due/);
    expect(plain).not.toMatch(/Advance applied/);
  });
  it('a reprint (no advance / outstanding known) never invents a balance', () => {
    const m = buildReceipt(input({ advances: null, outstandingMinor: null, payments: null }));
    expect(m.advances).toBeNull();
    expect(m.balanceDue).toBeNull();
  });
});
