import { describe, expect, it } from 'vitest';
import type { PosCustomerReceiptResult } from '@flower/api-client';
import {
  COLLECT_METHODS,
  buildCollectionReceipt,
  collectErrorMessage,
  collectFingerprint,
  collectKeyFor,
  collectionReceiptText,
  newCollectAttempt,
  planCollection,
  receivableStatus,
  statementLabel,
  paymentLines,
  signedMinor,
} from './collection';

/**
 * CUSTOMER ACCOUNT + CREDIT COLLECTION — the POS side of the FROZEN `POST …/customers/:id/receipts` contract. The SERVER allocates the money
 * (oldest receivable first), owns every balance and every identifier; this module only builds the request (amount + method), previews it, keys it for
 * idempotency, and ARRANGES the server's answer into a receipt. Nothing here computes a financial total that is printed.
 */
const bi = (n: number) => BigInt(n);

describe('collection planning — advisory preview of rules the server enforces again', () => {
  it('a partial collection is exactly the amount and method, as strings of minor units — nothing else can be expressed', () => {
    const p = planCollection({ outstandingMinor: bi(3150), amountMinor: bi(1000), method: 'CASH' });
    expect(p).toEqual({
      ok: true,
      request: { amountMinor: '1000', method: 'CASH' },
      remainingAfterMinor: bi(2150),
    });
    if (p.ok) expect(Object.keys(p.request).sort()).toEqual(['amountMinor', 'method']);
  });

  it('collecting the whole outstanding amount is allowed', () => {
    const p = planCollection({
      outstandingMinor: bi(3150),
      amountMinor: bi(3150),
      method: 'BANK_TRANSFER',
    });
    expect(p).toMatchObject({
      ok: true,
      request: { amountMinor: '3150', method: 'BANK_TRANSFER' },
      remainingAfterMinor: bi(0),
    });
  });

  it('refuses a missing, zero, negative or unreadable amount before any request', () => {
    const r = (a: bigint | null | undefined) =>
      planCollection({ outstandingMinor: bi(500), amountMinor: a, method: 'CASH' });
    expect(r(null)).toEqual({ ok: false, reason: 'AMOUNT_REQUIRED' });
    expect(r(undefined)).toEqual({ ok: false, reason: 'AMOUNT_INVALID' });
    expect(r(0n)).toEqual({ ok: false, reason: 'AMOUNT_INVALID' });
    expect(r(-1n)).toEqual({ ok: false, reason: 'AMOUNT_INVALID' });
  });

  it('the till never takes more than is owed (an excess would become unallocated customer money) and never when nothing is owed', () => {
    expect(
      planCollection({ outstandingMinor: bi(500), amountMinor: bi(501), method: 'CASH' }),
    ).toEqual({ ok: false, reason: 'EXCEEDS_OUTSTANDING' });
    expect(planCollection({ outstandingMinor: bi(0), amountMinor: bi(1), method: 'CASH' })).toEqual(
      { ok: false, reason: 'NOTHING_OUTSTANDING' },
    );
  });

  it('offers ONLY the methods the frozen contract accepts: cash, bank transfer, other — never card', () => {
    expect(COLLECT_METHODS.map((m) => m.value)).toEqual(['CASH', 'BANK_TRANSFER', 'OTHER_MANUAL']);
    expect(JSON.stringify(COLLECT_METHODS)).not.toMatch(/card|terminal|gateway/i);
  });
});

describe('idempotency — the same collection replays, any change is a new collection', () => {
  const uuid = (() => {
    let i = 0;
    return () => `key-${++i}`;
  })();
  const req = { amountMinor: '1000', method: 'CASH' as const };

  it('the fingerprint covers the customer, the amount and the method', () => {
    const base = collectFingerprint('cust-1', req);
    expect(collectFingerprint('cust-1', { ...req })).toBe(base);
    expect(
      new Set([
        base,
        collectFingerprint('cust-2', req),
        collectFingerprint('cust-1', { ...req, amountMinor: '1001' }),
        collectFingerprint('cust-1', { ...req, method: 'BANK_TRANSFER' }),
      ]).size,
    ).toBe(4);
  });

  it('a retry of the same collection reuses the key; a changed one gets a new key; going back replays the first', () => {
    const a0 = newCollectAttempt();
    const k1 = collectKeyFor(a0, 'cust-1', req, uuid);
    const k1b = collectKeyFor(k1.attempt, 'cust-1', req, uuid);
    expect(k1b.key).toBe(k1.key);
    const k2 = collectKeyFor(k1b.attempt, 'cust-1', { ...req, amountMinor: '500' }, uuid);
    expect(k2.key).not.toBe(k1.key);
    expect(collectKeyFor(k2.attempt, 'cust-1', req, uuid).key).toBe(k1.key);
  });

  it('after a successful collection the till starts a FRESH attempt, so a second identical collection is a second payment on purpose', () => {
    const a1 = collectKeyFor(newCollectAttempt(), 'cust-1', req, uuid);
    const fresh = newCollectAttempt();
    expect(collectKeyFor(fresh, 'cust-1', req, uuid).key).not.toBe(a1.key);
  });
});

describe('receivable status and statement wording — display of server figures, no arithmetic on money', () => {
  const row = (original: string, outstanding: string) => ({
    originalAmountMinor: original,
    outstandingMinor: outstanding,
  });
  it('unpaid when nothing was paid, part paid when some was', () => {
    expect(receivableStatus(row('2100', '2100'))).toBe('UNPAID');
    expect(receivableStatus(row('2100', '1100'))).toBe('PART PAID');
  });
  it('known statement kinds read in plain words; an unknown kind is shown from its own name, never hidden', () => {
    expect(statementLabel('INVOICE')).toBe('Invoice');
    expect(statementLabel('PAYMENT_ALLOCATION')).toBe('Payment applied to invoice');
    expect(statementLabel('ADVANCE_APPLIED')).toBe('Advance applied');
    expect(statementLabel('SOME_FUTURE_KIND')).toBe('Some future kind');
  });
  it('payment lines are the statement entries where money was applied, newest information kept as the server sent it', () => {
    const line = (kind: string, rec: string) => ({
      customerAccountEntryId: kind + rec,
      entryKind: kind,
      financialDate: '2026-11-18',
      occurredAt: '2026-11-18T10:00:00.000Z',
      receivableEffectMinor: rec,
      advanceEffectMinor: '0',
      unappliedReceiptEffectMinor: '0',
      refs: { paymentId: 'p1', customerReceivableId: 'r1' },
    });
    const lines = [
      line('INVOICE', '2100'),
      line('PAYMENT_ALLOCATION', '-1000'),
      line('ADVANCE_APPLIED', '-500'),
    ];
    expect(paymentLines(lines).map((l) => l.entryKind)).toEqual(['PAYMENT_ALLOCATION']);
  });
});

describe('collection receipt — the SERVER’s figures, arranged', () => {
  const result: PosCustomerReceiptResult = {
    paymentId: '0192f3c2-7b1e-7a3a-8c55-3f5d6a7b8c01',
    paymentAttemptId: 'att-1',
    amountMinor: '1500',
    allocatedAmountMinor: '1500',
    unallocatedAmountMinor: '0',
    currencyCode: 'AED',
    currencyExponent: 2,
    allocations: [
      { receivableId: 'r-old', sourceType: 'INVOICE', amountMinor: '1100' },
      { receivableId: 'r-new', sourceType: 'INVOICE', amountMinor: '400' },
    ],
  };
  const seller = { name: 'Rose Co', trn: '100123456700003', address: 'Shop 4, Dubai' };
  const open = [
    { customerReceivableId: 'r-old', invoiceNumber: 'INV-000001', sourceType: 'INVOICE' },
    { customerReceivableId: 'r-new', invoiceNumber: 'INV-000002', sourceType: 'INVOICE' },
  ];
  const input = {
    seller,
    branchName: 'Main',
    customerName: 'Dora Debtor',
    method: 'CASH' as const,
    result,
    receivables: open,
    balanceAfterMinor: '1650',
    asOf: '2026-11-18T10:22:05.000Z',
    copy: 'ORIGINAL' as const,
  };

  it('carries the server payment reference, amount, method, each allocation with its invoice number, and the server balance after', () => {
    const m = buildCollectionReceipt(input);
    expect(m.title).toBe('PAYMENT RECEIPT');
    expect(m.reference).toBe(result.paymentId);
    expect(m.customerName).toBe('Dora Debtor');
    expect(m.method).toBe('Cash');
    expect(m.amount).toBe('15.00');
    expect(m.allocations).toEqual([
      { reference: 'INV-000001', amount: '11.00' },
      { reference: 'INV-000002', amount: '4.00' },
    ]);
    expect(m.unallocated).toBeNull();
    expect(m.balanceAfter).toBe('16.50');
    expect(m.currency).toBe('AED');
    expect(m.date).toBe('2026-11-18 10:22 UTC');
    expect(m.seller.name).toBe('Rose Co');
    expect(m.branchName).toBe('Main');
    expect(m.copy).toBe('ORIGINAL');
  });

  it('an allocation to a receivable the till did not list shows as "Customer account", never an invented invoice number; a KWD (3-decimal) amount is exact', () => {
    const m = buildCollectionReceipt({
      ...input,
      receivables: [],
      result: {
        ...result,
        currencyCode: 'KWD',
        currencyExponent: 3,
        amountMinor: '1500',
        allocations: [{ receivableId: 'x', sourceType: 'OPENING', amountMinor: '1500' }],
      },
    });
    expect(m.amount).toBe('1.500');
    expect(m.allocations).toEqual([{ reference: 'Customer account', amount: '1.500' }]);
  });

  it('money the server left unallocated is shown as the server reported it; an unknown balance after is not invented', () => {
    const m = buildCollectionReceipt({
      ...input,
      balanceAfterMinor: null,
      result: { ...result, allocatedAmountMinor: '1000', unallocatedAmountMinor: '500' },
    });
    expect(m.unallocated).toBe('5.00');
    expect(m.balanceAfter).toBeNull();
  });

  it('a reprint is marked COPY, and says nothing the original did not', () => {
    const copy = buildCollectionReceipt({ ...input, copy: 'COPY' });
    expect(copy.copy).toBe('COPY');
    const text = collectionReceiptText(copy).join('\n');
    expect(text).toMatch(/PAYMENT RECEIPT \(COPY\)/);
  });

  it('the printed text has the customer, reference, amount, method, invoice references, balance after, company and branch — and no cash-register claim', () => {
    const text = collectionReceiptText(buildCollectionReceipt(input)).join('\n');
    for (const needle of [
      'Rose Co',
      'TRN 100123456700003',
      'Main',
      'Dora Debtor',
      result.paymentId.slice(0, 8),
      'Cash',
      '15.00',
      'INV-000001',
      '11.00',
      'INV-000002',
      '4.00',
      'Balance after',
      '16.50',
      '2026-11-18 10:22 UTC',
    ])
      expect(text, needle).toContain(needle);
    expect(text).not.toMatch(/register|drawer|Z-report|X-report|shift/i);
  });
});

describe('cashier-facing refusals for a collection', () => {
  const msg = (code: string, status = 422) => collectErrorMessage(code, status);
  it('says what happened and what to do', () => {
    expect(msg('PAYMENT_INVALID_AMOUNT')).toMatch(/amount/i);
    expect(msg('PAYMENT_ASYNC_TENDER_NOT_ALLOWED_IN_ATOMIC_MULTI_PAYMENT')).toMatch(
      /cash|transfer/i,
    );
    expect(msg('CUSTOMER_COMPANY_ACCOUNT_NOT_FOUND', 404)).toMatch(/account/i);
    expect(msg('IDEMPOTENCY_IN_PROGRESS', 409)).toMatch(/already being|moment|try again/i);
    expect(msg('IDEMPOTENCY_KEY_REUSED', 422)).toMatch(/different|already/i);
    expect(msg('FORBIDDEN', 403)).toMatch(/not allowed/i);
    expect(msg('VALIDATION_FAILED', 400)).toMatch(/check/i);
  });
  it('a lost connection is explicit that the payment may or may not be recorded, and that the retry is safe', () => {
    expect(collectErrorMessage('NETWORK', 0)).toMatch(/may or may not/i);
    expect(collectErrorMessage('NETWORK', 0)).toMatch(/safe|never taken twice/i);
  });
  it('an unexpected server error warns not to hand over money twice', () => {
    expect(msg('X', 500)).toMatch(/check the customer.?s account/i);
  });
});

describe('signed statement effects — the server’s sign is kept, the digits are formatted exactly', () => {
  it('shows + / − and the amount; zero shows a dash', () => {
    expect(signedMinor('2100', 2)).toBe('+21.00');
    expect(signedMinor('-1000', 2)).toBe('−10.00');
    expect(signedMinor('0', 2)).toBe('—');
    expect(signedMinor('-1500', 3)).toBe('−1.500');
  });
});
