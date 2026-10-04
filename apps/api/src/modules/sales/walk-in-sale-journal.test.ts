import { describe, expect, it } from 'vitest';
import { computeCanonicalTotals } from '../orders/canonical-totals.js';
import {
  buildWalkInSaleJournal,
  DEBIT_ACCOUNT_ORDER,
  WALK_IN_SALE_SOURCE_KIND,
  type BuildWalkInSaleJournalInput,
  type WalkInJournalLine,
} from './walk-in-sale-journal.js';

/**
 * Task 3b.9 Checkpoint A (A3) — the pure anonymous walk-in journal plan.
 * The plan is NOT posted here (Checkpoint B owns posting).
 */
const INVOICE_ID = 'f0000000-0000-7000-8000-0000000000f1';

const build = (over: Partial<BuildWalkInSaleJournalInput> = {}) =>
  buildWalkInSaleJournal({
    invoiceId: INVOICE_ID,
    customerId: null,
    currencyCode: 'AED',
    currencyExponent: 2,
    totalAmountMinor: 10_500n,
    taxTotalAmountMinor: 500n,
    tenders: [{ method: 'CASH', amountMinor: 10_500n }],
    ...over,
  });

const shape = (lines: readonly WalkInJournalLine[]) =>
  lines.map((l) => `${l.direction === 'debit' ? 'Dr' : 'Cr'} ${l.accountKey} ${l.amountMinor}`);

describe('buildWalkInSaleJournal — exact journal examples', () => {
  it('CASH sale of 105.00 (net 100.00 + 5.00 VAT)', () => {
    const plan = build();
    expect(plan.sourceKind).toBe('walk_in_sale');
    expect(plan.sourceId).toBe(INVOICE_ID);
    expect(shape(plan.lines)).toEqual([
      'Dr ASSET.CASH_ON_HAND 10500',
      'Cr REVENUE.SALES 10000',
      'Cr LIABILITY.TAX_PAYABLE 500',
    ]);
    expect(plan.totalDebitMinor).toBe(10_500n);
    expect(plan.totalCreditMinor).toBe(10_500n);
  });

  it('BANK_TRANSFER sale of 26.25 (net 25.00 + 1.25 VAT)', () => {
    const plan = build({
      totalAmountMinor: 2_625n,
      taxTotalAmountMinor: 125n,
      tenders: [{ method: 'BANK_TRANSFER', amountMinor: 2_625n }],
    });
    expect(shape(plan.lines)).toEqual([
      'Dr ASSET.BANK 2625',
      'Cr REVENUE.SALES 2500',
      'Cr LIABILITY.TAX_PAYABLE 125',
    ]);
  });

  it('Multi Payment of 44.42: cash + bank + manual card slip + other-manual (the last two share ASSET.PAYMENT_CLEARING)', () => {
    const plan = build({
      totalAmountMinor: 4_442n,
      taxTotalAmountMinor: 212n,
      tenders: [
        { method: 'CARD_TERMINAL', amountMinor: 500n },
        { method: 'BANK_TRANSFER', amountMinor: 1_442n },
        { method: 'CASH', amountMinor: 2_000n },
        { method: 'OTHER_MANUAL', amountMinor: 500n },
      ],
    });
    expect(shape(plan.lines)).toEqual([
      'Dr ASSET.CASH_ON_HAND 2000',
      'Dr ASSET.BANK 1442',
      'Dr ASSET.PAYMENT_CLEARING 1000',
      'Cr REVENUE.SALES 4230',
      'Cr LIABILITY.TAX_PAYABLE 212',
    ]);
    expect(plan.totalDebitMinor).toBe(4_442n);
  });

  it('a zero-tax sale posts no tax line (a zero-valued line would violate the sealed-journal CHECK)', () => {
    const plan = build({
      totalAmountMinor: 777n,
      taxTotalAmountMinor: 0n,
      tenders: [{ method: 'CASH', amountMinor: 777n }],
    });
    expect(shape(plan.lines)).toEqual(['Dr ASSET.CASH_ON_HAND 777', 'Cr REVENUE.SALES 777']);
  });

  it('a sale that is ALL tax posts no revenue line', () => {
    const plan = build({
      totalAmountMinor: 50n,
      taxTotalAmountMinor: 50n,
      tenders: [{ method: 'CASH', amountMinor: 50n }],
    });
    expect(shape(plan.lines)).toEqual(['Dr ASSET.CASH_ON_HAND 50', 'Cr LIABILITY.TAX_PAYABLE 50']);
  });

  it('a 3-decimal currency (KWD) books in fils with the same exactness', () => {
    const plan = build({
      currencyCode: 'KWD',
      currencyExponent: 3,
      totalAmountMinor: 3_938n,
      taxTotalAmountMinor: 188n,
      tenders: [
        { method: 'CASH', amountMinor: 1_938n },
        { method: 'BANK_TRANSFER', amountMinor: 2_000n },
      ],
    });
    expect(shape(plan.lines)).toEqual([
      'Dr ASSET.CASH_ON_HAND 1938',
      'Dr ASSET.BANK 2000',
      'Cr REVENUE.SALES 3750',
      'Cr LIABILITY.TAX_PAYABLE 188',
    ]);
  });
});

describe('buildWalkInSaleJournal — aggregation and determinism', () => {
  it('repeated same-account tenders aggregate into ONE debit line', () => {
    const plan = build({
      totalAmountMinor: 10_000n,
      taxTotalAmountMinor: 0n,
      tenders: [
        { method: 'CASH', amountMinor: 1_000n },
        { method: 'CASH', amountMinor: 2_000n },
        { method: 'CASH', amountMinor: 3_000n },
        { method: 'CARD_TERMINAL', amountMinor: 1_500n },
        { method: 'OTHER_MANUAL', amountMinor: 2_500n },
      ],
    });
    expect(shape(plan.lines)).toEqual([
      'Dr ASSET.CASH_ON_HAND 6000',
      'Dr ASSET.PAYMENT_CLEARING 4000',
      'Cr REVENUE.SALES 10000',
    ]);
  });

  it('line order never depends on tender order: debits in the fixed account order, then revenue, then tax', () => {
    const tenders = [
      { method: 'OTHER_MANUAL', amountMinor: 1_000n },
      { method: 'BANK_TRANSFER', amountMinor: 2_000n },
      { method: 'CASH', amountMinor: 7_500n },
    ];
    const base = build({ taxTotalAmountMinor: 100n, tenders });
    for (const permutation of [
      [2, 1, 0],
      [1, 0, 2],
      [0, 2, 1],
    ]) {
      const p = build({ taxTotalAmountMinor: 100n, tenders: permutation.map((i) => tenders[i]!) });
      expect(p.lines).toEqual(base.lines);
    }
    expect(base.lines.map((l) => l.accountKey)).toEqual([
      ...DEBIT_ACCOUNT_ORDER,
      'REVENUE.SALES',
      'LIABILITY.TAX_PAYABLE',
    ]);
  });

  it('is deterministic across repeated calls and returns a frozen plan', () => {
    const first = build();
    for (let i = 0; i < 25; i += 1) expect(build()).toEqual(first);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.lines)).toBe(true);
    expect(Object.isFrozen(first.lines[0])).toBe(true);
  });

  it('does not mutate the tender array it is given', () => {
    const tenders = [
      { method: 'BANK_TRANSFER', amountMinor: 500n },
      { method: 'CASH', amountMinor: 10_000n },
    ];
    const before = structuredClone(tenders);
    build({ tenders });
    expect(tenders).toEqual(before);
  });
});

describe('buildWalkInSaleJournal — exact balance (property over a seeded matrix)', () => {
  function prng(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const METHODS = ['CASH', 'BANK_TRANSFER', 'OTHER_MANUAL', 'CARD_TERMINAL'];

  it('600 random sales: debits == credits == total, every line positive, same-account legs aggregated, reproducible under shuffling', () => {
    const rand = prng(0x3b09b);
    for (let n = 0; n < 600; n += 1) {
      const total = BigInt(1 + Math.floor(rand() * 5_000_000));
      const tax = BigInt(Math.floor(rand() * Number(total) * (rand() < 0.3 ? 0 : 0.3)));
      // split the total into 1..6 positive parts
      const parts = 1 + Math.floor(rand() * 6);
      const cuts = new Set<number>();
      while (cuts.size < Math.min(parts - 1, Number(total) - 1)) {
        cuts.add(1 + Math.floor(rand() * (Number(total) - 1)));
      }
      const bounds = [0, ...[...cuts].sort((a, b) => a - b), Number(total)];
      const tenders = bounds.slice(1).map((b, i) => ({
        method: METHODS[Math.floor(rand() * METHODS.length)]!,
        amountMinor: BigInt(b - bounds[i]!),
      }));
      const plan = build({ totalAmountMinor: total, taxTotalAmountMinor: tax, tenders });

      expect(plan.totalDebitMinor).toBe(total);
      expect(plan.totalCreditMinor).toBe(total);
      const debits = plan.lines.filter((l) => l.direction === 'debit');
      const credits = plan.lines.filter((l) => l.direction === 'credit');
      expect(debits.reduce((a, l) => a + l.amountMinor, 0n)).toBe(total);
      expect(credits.reduce((a, l) => a + l.amountMinor, 0n)).toBe(total);
      expect(plan.lines.every((l) => l.amountMinor > 0n)).toBe(true);
      expect(new Set(debits.map((l) => l.accountKey)).size).toBe(debits.length); // aggregated
      expect(plan.lines.length).toBeGreaterThanOrEqual(2);
      const revenue = credits.find((l) => l.accountKey === 'REVENUE.SALES');
      const taxLine = credits.find((l) => l.accountKey === 'LIABILITY.TAX_PAYABLE');
      expect(revenue?.amountMinor ?? 0n).toBe(total - tax);
      expect(taxLine?.amountMinor ?? 0n).toBe(tax);
      expect(
        build({
          totalAmountMinor: total,
          taxTotalAmountMinor: tax,
          tenders: [...tenders].reverse(),
        }),
      ).toEqual(plan);
    }
  });
});

describe('buildWalkInSaleJournal — the net-of-discount revenue convention (OD-3)', () => {
  const orderPolicy = {
    currencyCode: 'AED',
    currencyExponent: 2,
    taxRoundingScope: 'LINE',
    taxRoundingMode: 'HALF_UP',
  };
  const line = (pos: number, unit: bigint, discount: bigint) => ({
    id: `l${pos}`,
    linePosition: pos,
    quantity: '1.0000',
    unitPriceAmountMinor: unit,
    unitPriceCurrencyCode: 'AED',
    discountAmountMinor: discount,
    rateBps: 500,
  });

  for (const taxPriceMode of ['TAX_EXCLUSIVE', 'TAX_INCLUSIVE']) {
    it(`${taxPriceMode}: Cr REVENUE.SALES is the sale net of line AND document discounts and of tax — discounts are not booked to a contra account`, () => {
      const canonical = computeCanonicalTotals(
        { ...orderPolicy, taxPriceMode, documentDiscountAmountMinor: 380n },
        [line(1, 3000n, 450n), line(2, 1500n, 250n)], // gross 4500, line discounts 700, doc discount 380
      );
      const t = canonical.totals;
      const plan = build({
        totalAmountMinor: t.totalAmountMinor,
        taxTotalAmountMinor: t.taxTotalAmountMinor,
        tenders: [{ method: 'CASH', amountMinor: t.totalAmountMinor }],
      });
      const revenue = plan.lines.find((l) => l.accountKey === 'REVENUE.SALES')!.amountMinor;
      const grossLessAllDiscounts = 4500n - 700n - 380n;
      expect(revenue).toBe(
        taxPriceMode === 'TAX_EXCLUSIVE'
          ? grossLessAllDiscounts
          : grossLessAllDiscounts - t.taxTotalAmountMinor,
      );
      expect(revenue).toBe(t.totalAmountMinor - t.taxTotalAmountMinor);
      // no contra-revenue / discount account anywhere in the plan
      expect(plan.lines.some((l) => /CONTRA|DISCOUNT/i.test(l.accountKey))).toBe(false);
      expect(plan.totalDebitMinor).toBe(t.totalAmountMinor);
    });
  }
});

describe('buildWalkInSaleJournal — fail closed', () => {
  const bad = (over: Partial<BuildWalkInSaleJournalInput>, re: RegExp) =>
    expect(() => build(over)).toThrow(re);

  it('rejects a provider-backed tender (ONLINE_GATEWAY, or CARD_TERMINAL with a credential)', () => {
    bad({ tenders: [{ method: 'ONLINE_GATEWAY', amountMinor: 10_500n }] }, /provider-backed/);
    bad(
      {
        tenders: [
          { method: 'CARD_TERMINAL', amountMinor: 10_500n, providerCredentialId: 'cred-1' },
        ],
      },
      /provider-backed/,
    );
  });

  it('rejects an unsupported tender (credit, advance, wallet, unknown)', () => {
    for (const method of ['CREDIT', 'ADVANCE', 'WALLET', 'STORE_CREDIT', 'cash', '']) {
      bad({ tenders: [{ method, amountMinor: 10_500n }] }, /is not a tender/);
    }
  });

  it('rejects a tender sum that is not the sale total — under or over (an anonymous sale is paid in full)', () => {
    bad({ tenders: [{ method: 'CASH', amountMinor: 10_499n }] }, /does not equal the sale total/);
    bad({ tenders: [{ method: 'CASH', amountMinor: 10_501n }] }, /does not equal the sale total/);
    bad({ tenders: [] }, /at least one tender/);
  });

  it('rejects zero, negative and non-BigInt amounts', () => {
    bad(
      {
        tenders: [
          { method: 'CASH', amountMinor: 0n },
          { method: 'CASH', amountMinor: 10_500n },
        ],
      },
      /> 0/,
    );
    bad(
      {
        tenders: [
          { method: 'CASH', amountMinor: -1n },
          { method: 'CASH', amountMinor: 10_501n },
        ],
      },
      /> 0/,
    );
    bad({ tenders: [{ method: 'CASH', amountMinor: 10_500 as unknown as bigint }] }, /BigInt/);
    bad({ totalAmountMinor: 10_500 as unknown as bigint }, /BigInt/);
    bad({ taxTotalAmountMinor: 500 as unknown as bigint }, /BigInt/);
  });

  it('rejects a zero / negative total, a negative tax, and tax above the total', () => {
    bad({ totalAmountMinor: 0n, tenders: [{ method: 'CASH', amountMinor: 1n }] }, /> 0/);
    bad({ taxTotalAmountMinor: -1n }, />= 0/);
    bad({ taxTotalAmountMinor: 10_501n }, /tax cannot exceed/);
  });

  it('rejects a customer-linked sale — it is booked by the frozen 3b.6 journals, never double-booked here', () => {
    bad({ customerId: 'c0000000-0000-7000-8000-000000000001' }, /ANONYMOUS/);
  });

  it('rejects an unknown currency / wrong exponent and a blank invoice id', () => {
    bad({ currencyCode: 'XXX' }, /known currency/);
    bad({ currencyExponent: 3 }, /known currency/);
    bad({ currencyCode: 'KWD', currencyExponent: 2 }, /known currency/);
    bad({ invoiceId: '' }, /invoiceId/);
    bad({ invoiceId: '   ' }, /invoiceId/);
  });

  it('plans the frozen source identity', () => {
    expect(WALK_IN_SALE_SOURCE_KIND).toBe('walk_in_sale');
    expect(build().sourceKind).toBe('walk_in_sale');
  });
});
