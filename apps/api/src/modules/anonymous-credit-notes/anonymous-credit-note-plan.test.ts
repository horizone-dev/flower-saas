import { describe, expect, it } from 'vitest';
import { Money } from '@flower/money';
import { Quantity } from '@flower/uom';
import { DomainError } from '../../common/errors/domain-error.js';
import { allocateDocumentDiscount } from '../orders/document-discount-allocation.js';
import {
  assertWithinTenderCaps,
  executionJournalLines,
  isBalanced,
  issuanceJournalLines,
  planAnonymousCreditNote,
  validateInitialRefunds,
  type FrozenOrderLine,
  type PriorLineCredit,
  type RefundMethod,
} from './anonymous-credit-note-plan.js';

const AED = 'AED';
const KWD = 'KWD';
const none = new Map<string, PriorLineCredit>();
const code = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(DomainError);
    return (e as DomainError).code;
  }
  return 'NO_ERROR';
};

/** a deterministic PRNG so the property tests are reproducible */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const line = (id: string, pos: number, o: Partial<FrozenOrderLine> = {}): FrozenOrderLine => ({
  id,
  linePosition: pos,
  quantity: '3.0000',
  unitPriceAmountMinor: 3333n,
  discountAmountMinor: 100n,
  priceTaxMode: 'TAX_EXCLUSIVE',
  lineTaxAmountMinor: 497n,
  ...o,
});

/** the frozen 3b.8 FULL-credit derivation, restated verbatim (credit-note.repository.ts steps 2–3) as the reference */
function reference3b8Full(lines: FrozenOrderLine[], docDiscount: bigint, cur: string) {
  const after = lines.map((l) => {
    const q = Quantity.parse(l.quantity).scaled;
    const gross = Money.ofMinor(l.unitPriceAmountMinor, cur).mulRatio(q, 10_000n).amountMinor;
    return { l, gross, after: gross - l.discountAmountMinor };
  });
  const alloc = allocateDocumentDiscount(
    after.map((a) => ({
      linePosition: a.l.linePosition,
      commercialAmountAfterLineDiscountMinor: a.after,
    })),
    docDiscount,
    cur,
  );
  const share = new Map(alloc.lines.map((x) => [x.linePosition, x.documentDiscountShareMinor]));
  return after.map((a) => {
    const s = share.get(a.l.linePosition)!;
    const net = a.after - s;
    const tax = a.l.lineTaxAmountMinor ?? 0n;
    return {
      id: a.l.id,
      gross: a.gross,
      share: s,
      net,
      tax,
      total: a.l.priceTaxMode === 'TAX_INCLUSIVE' ? net : net + tax,
    };
  });
}

describe('planAnonymousCreditNote — a FULL credit equals the frozen 3b.8 derivation exactly', () => {
  it('exclusive and inclusive lines, line discounts and a document discount', () => {
    const lines = [
      line('a', 1),
      line('b', 2, {
        quantity: '2.5000',
        unitPriceAmountMinor: 1999n,
        discountAmountMinor: 0n,
        lineTaxAmountMinor: 250n,
        priceTaxMode: 'TAX_INCLUSIVE',
      }),
      line('c', 3, {
        quantity: '1.0000',
        unitPriceAmountMinor: 10001n,
        discountAmountMinor: 333n,
        lineTaxAmountMinor: 483n,
      }),
    ];
    const docDiscount = 777n;
    const plan = planAnonymousCreditNote({
      currencyCode: AED,
      orderDocumentDiscountMinor: docDiscount,
      orderLines: lines,
      priorByLine: none,
      requested: lines.map((l) => ({ orderLineId: l.id, quantity: l.quantity })),
    });
    const ref = reference3b8Full(lines, docDiscount, AED);
    expect(
      plan.lines.map((l) => [
        l.orderLineId,
        l.grossCreditedMinor,
        l.documentDiscountShareCreditedMinor,
        l.netAfterDocumentDiscountCreditedMinor,
        l.taxCreditedMinor,
        l.lineTotalCreditedMinor,
      ]),
    ).toEqual(ref.map((r) => [r.id, r.gross, r.share, r.net, r.tax, r.total]));
    expect(plan.totalAmountMinor).toBe(ref.reduce((a, r) => a + r.total, 0n));
    expect(plan.taxTotalAmountMinor).toBe(ref.reduce((a, r) => a + r.tax, 0n));
  });

  it('three-decimal currency (KWD): minor units are baisa-exact', () => {
    const lines = [
      line('k', 1, {
        quantity: '3.0000',
        unitPriceAmountMinor: 12345n,
        discountAmountMinor: 0n,
        lineTaxAmountMinor: 1852n,
      }),
    ];
    const plan = planAnonymousCreditNote({
      currencyCode: KWD,
      orderDocumentDiscountMinor: 0n,
      orderLines: lines,
      priorByLine: none,
      requested: [{ orderLineId: 'k', quantity: '3' }],
    });
    expect(plan.totalAmountMinor).toBe(12345n * 3n + 1852n);
  });
});

describe('planAnonymousCreditNote — PARTIAL credits', () => {
  it('property: ANY sequence of partial credits ending with the final one sums EXACTLY to the frozen line (no dust, no over-credit)', () => {
    const rnd = lcg(20261111);
    for (let trial = 0; trial < 300; trial++) {
      const qty = 1 + Math.floor(rnd() * 12); // 1..12 whole units
      const l = line('p', 1, {
        quantity: `${qty}.0000`,
        unitPriceAmountMinor: BigInt(100 + Math.floor(rnd() * 99_900)),
        discountAmountMinor: BigInt(Math.floor(rnd() * 300)),
        lineTaxAmountMinor: BigInt(Math.floor(rnd() * 5000)),
        priceTaxMode: rnd() < 0.5 ? 'TAX_INCLUSIVE' : 'TAX_EXCLUSIVE',
      });
      const doc = BigInt(Math.floor(rnd() * 200));
      let remaining = qty;
      let prior: PriorLineCredit = {
        quantityScaled: 0n,
        grossMinor: 0n,
        discountMinor: 0n,
        documentDiscountShareMinor: 0n,
        taxMinor: 0n,
      };
      let totalTax = 0n;
      let totalNet = 0n;
      let totalGross = 0n;
      let totalDiscount = 0n;
      let totalShare = 0n;
      while (remaining > 0) {
        const take = remaining === 1 ? 1 : 1 + Math.floor(rnd() * remaining);
        const plan = planAnonymousCreditNote({
          currencyCode: AED,
          orderDocumentDiscountMinor: doc,
          orderLines: [l],
          priorByLine: new Map([['p', prior]]),
          requested: [{ orderLineId: 'p', quantity: String(take) }],
        });
        const c = plan.lines[0]!;
        expect(c.netAfterDocumentDiscountCreditedMinor).toBeGreaterThanOrEqual(0n);
        prior = {
          quantityScaled: prior.quantityScaled + BigInt(take) * 10_000n,
          grossMinor: prior.grossMinor + c.grossCreditedMinor,
          discountMinor: prior.discountMinor + c.discountCreditedMinor,
          documentDiscountShareMinor:
            prior.documentDiscountShareMinor + c.documentDiscountShareCreditedMinor,
          taxMinor: prior.taxMinor + c.taxCreditedMinor,
        };
        totalTax += c.taxCreditedMinor;
        totalNet += c.netAfterDocumentDiscountCreditedMinor;
        totalGross += c.grossCreditedMinor;
        totalDiscount += c.discountCreditedMinor;
        totalShare += c.documentDiscountShareCreditedMinor;
        remaining -= take;
      }
      const ref = reference3b8Full([l], doc, AED)[0]!;
      expect([totalGross, totalDiscount, totalShare, totalNet, totalTax]).toEqual([
        ref.gross,
        l.discountAmountMinor,
        ref.share,
        ref.net,
        ref.tax,
      ]);
    }
  });

  it('a partial credit is the floored proportion; the final credit takes the exact remainder', () => {
    const l = line('x', 1, {
      quantity: '3.0000',
      unitPriceAmountMinor: 1000n,
      discountAmountMinor: 100n,
      lineTaxAmountMinor: 100n,
    });
    const first = planAnonymousCreditNote({
      currencyCode: AED,
      orderDocumentDiscountMinor: 0n,
      orderLines: [l],
      priorByLine: none,
      requested: [{ orderLineId: 'x', quantity: '1' }],
    }).lines[0]!;
    expect(first.taxCreditedMinor).toBe(33n); // floor(100 × 1/3)
    expect(first.discountCreditedMinor).toBe(33n);
    const prior: PriorLineCredit = {
      quantityScaled: 10_000n,
      grossMinor: first.grossCreditedMinor,
      discountMinor: 33n,
      documentDiscountShareMinor: 0n,
      taxMinor: 33n,
    };
    const fin = planAnonymousCreditNote({
      currencyCode: AED,
      orderDocumentDiscountMinor: 0n,
      orderLines: [l],
      priorByLine: new Map([['x', prior]]),
      requested: [{ orderLineId: 'x', quantity: '2' }],
    }).lines[0]!;
    expect(fin.taxCreditedMinor).toBe(67n); // 100 − 33
    expect(fin.discountCreditedMinor).toBe(67n);
  });

  it('refuses: over-credit, a second pass over an exhausted line, bad quantities, duplicates, foreign lines, empty requests', () => {
    const l = line('y', 1);
    const run = (requested: { orderLineId: string; quantity: string }[], prior = none) =>
      planAnonymousCreditNote({
        currencyCode: AED,
        orderDocumentDiscountMinor: 0n,
        orderLines: [l],
        priorByLine: prior,
        requested,
      });
    expect(code(() => run([{ orderLineId: 'y', quantity: '3.0001' }]))).toBe(
      'CREDIT_NOTE_QUANTITY_EXCEEDS_REMAINING',
    );
    expect(
      code(() =>
        run(
          [{ orderLineId: 'y', quantity: '1' }],
          new Map([
            [
              'y',
              {
                quantityScaled: 30_000n,
                grossMinor: 0n,
                discountMinor: 0n,
                documentDiscountShareMinor: 0n,
                taxMinor: 0n,
              },
            ],
          ]),
        ),
      ),
    ).toBe('CREDIT_NOTE_QUANTITY_EXCEEDS_REMAINING');
    for (const q of ['0', '-1', 'abc', '', '1.00001'])
      expect(
        code(() => run([{ orderLineId: 'y', quantity: q }])),
        q,
      ).toBe('CREDIT_NOTE_QUANTITY_INVALID');
    expect(
      code(() =>
        run([
          { orderLineId: 'y', quantity: '1' },
          { orderLineId: 'y', quantity: '1' },
        ]),
      ),
    ).toBe('CREDIT_NOTE_DUPLICATE_LINE');
    expect(code(() => run([{ orderLineId: 'nope', quantity: '1' }]))).toBe(
      'CREDIT_NOTE_LINE_NOT_IN_ORDER',
    );
    expect(code(() => run([]))).toBe('CREDIT_NOTE_NO_LINES');
  });
});

describe('refund validation', () => {
  const paid = new Map<string, bigint>([
    ['CASH', 6000n],
    ['CARD_TERMINAL', 4500n],
  ]);
  const used = new Map<string, bigint>();
  const r = (method: RefundMethod, amountMinor: bigint) => ({ method, amountMinor });

  it('the refund lines must sum to the credit total exactly', () => {
    expect(
      validateInitialRefunds({
        totalAmountMinor: 10500n,
        refunds: [r('CASH', 6000n), r('CARD_TERMINAL', 4500n)],
        paidByMethod: paid,
        usedByMethod: used,
      }),
    ).toHaveLength(2);
    expect(
      code(() =>
        validateInitialRefunds({
          totalAmountMinor: 10500n,
          refunds: [r('CASH', 6000n)],
          paidByMethod: paid,
          usedByMethod: used,
        }),
      ),
    ).toBe('REFUND_TOTAL_MISMATCH');
    expect(
      code(() =>
        validateInitialRefunds({
          totalAmountMinor: 10500n,
          refunds: [r('CASH', 10500n)],
          paidByMethod: paid,
          usedByMethod: used,
        }),
      ),
    ).toBe('REFUND_EXCEEDS_TENDER');
  });

  it('a card payment can never be refunded as cash; used amounts count; a tender that was not used has a cap of 0', () => {
    expect(
      code(() =>
        assertWithinTenderCaps({
          refunds: [r('CASH', 6001n)],
          paidByMethod: paid,
          usedByMethod: used,
        }),
      ),
    ).toBe('REFUND_EXCEEDS_TENDER');
    expect(
      code(() =>
        assertWithinTenderCaps({
          refunds: [r('CASH', 1000n)],
          paidByMethod: paid,
          usedByMethod: new Map([['CASH', 5500n]]),
        }),
      ),
    ).toBe('REFUND_EXCEEDS_TENDER');
    expect(
      code(() =>
        assertWithinTenderCaps({
          refunds: [r('BANK_TRANSFER', 1n)],
          paidByMethod: paid,
          usedByMethod: used,
        }),
      ),
    ).toBe('REFUND_EXCEEDS_TENDER');
    expect(
      code(() =>
        assertWithinTenderCaps({
          refunds: [r('CASH', 0n)],
          paidByMethod: paid,
          usedByMethod: used,
        }),
      ),
    ).toBe('REFUND_AMOUNT_INVALID');
    expect(
      code(() =>
        assertWithinTenderCaps({
          refunds: [r('CASH', 4000n), r('CASH', 2001n)],
          paidByMethod: paid,
          usedByMethod: used,
        }),
      ),
    ).toBe('REFUND_EXCEEDS_TENDER'); // same tender twice is summed
    expect(
      code(() =>
        assertWithinTenderCaps({
          refunds: [r('CASH', 4000n), r('CASH', 2000n)],
          paidByMethod: paid,
          usedByMethod: used,
        }),
      ),
    ).toBe('NO_ERROR');
  });
});

describe('journal plans (existing accounts only; balanced; frozen net-of-discount convention)', () => {
  it('issuance: Dr REVENUE (total − tax) · Dr TAX / Cr PAYMENT_CLEARING (total) — the worked example 105.00 = 100.00 + 5.00', () => {
    const j = issuanceJournalLines(10500n, 500n);
    expect(j).toEqual([
      { accountKey: 'REVENUE.SALES', direction: 'debit', amountMinor: 10000n },
      { accountKey: 'LIABILITY.TAX_PAYABLE', direction: 'debit', amountMinor: 500n },
      { accountKey: 'ASSET.PAYMENT_CLEARING', direction: 'credit', amountMinor: 10500n },
    ]);
    expect(isBalanced(j)).toBe(true);
  });

  it('a zero-tax credit has no tax leg; an all-tax edge has no revenue leg; both stay balanced', () => {
    expect(issuanceJournalLines(1000n, 0n).map((l) => l.accountKey)).toEqual([
      'REVENUE.SALES',
      'ASSET.PAYMENT_CLEARING',
    ]);
    expect(isBalanced(issuanceJournalLines(1000n, 0n))).toBe(true);
    expect(issuanceJournalLines(500n, 500n).map((l) => l.accountKey)).toEqual([
      'LIABILITY.TAX_PAYABLE',
      'ASSET.PAYMENT_CLEARING',
    ]);
  });

  it('execution: cash → CASH_ON_HAND, bank → BANK; manual card / other post NOTHING (the sale debited PAYMENT_CLEARING itself)', () => {
    expect(executionJournalLines('CASH', 6000n)).toEqual([
      { accountKey: 'ASSET.PAYMENT_CLEARING', direction: 'debit', amountMinor: 6000n },
      { accountKey: 'ASSET.CASH_ON_HAND', direction: 'credit', amountMinor: 6000n },
    ]);
    expect(executionJournalLines('BANK_TRANSFER', 1n)![1]!.accountKey).toBe('ASSET.BANK');
    expect(executionJournalLines('CARD_TERMINAL', 4500n)).toBeNull();
    expect(executionJournalLines('OTHER_MANUAL', 4500n)).toBeNull();
  });

  it('net effect of issuance + all executions of the worked example: revenue and tax reversed, cash −60.00, clearing −45.00', () => {
    const lines = [
      ...issuanceJournalLines(10500n, 500n),
      ...(executionJournalLines('CASH', 6000n) ?? []),
    ];
    const net = new Map<string, bigint>();
    for (const l of lines)
      net.set(
        l.accountKey,
        (net.get(l.accountKey) ?? 0n) + (l.direction === 'debit' ? l.amountMinor : -l.amountMinor),
      );
    expect(Object.fromEntries(net)).toEqual({
      'REVENUE.SALES': 10000n,
      'LIABILITY.TAX_PAYABLE': 500n,
      'ASSET.PAYMENT_CLEARING': -4500n, // the card part stays credited (refund via the terminal)
      'ASSET.CASH_ON_HAND': -6000n,
    });
  });
});
