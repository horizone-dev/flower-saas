import { describe, expect, it } from 'vitest';
import { DomainError } from '../../common/errors/domain-error.js';
import { TENDER_METHODS } from '../payments/tender.js';
import {
  TENDER_NET_NOTE,
  buildTenderTotalsBlocks,
  sumTenderAggregates,
  type TenderBranchAggregate,
  type TenderGlAggregate,
} from './tender-totals-report.js';

/**
 * Task 3b.10 Checkpoint C — the PURE Tender Totals arithmetic. No DB, no HTTP, no clock. Exact `bigint`
 * minor units only; money leaves as decimal strings.
 */
const BR = '00000000-0000-7000-8000-00000000000a';
const BR2 = '00000000-0000-7000-8000-00000000000b';

const CR = 'customer_receipt_payment';
const WI = 'walk_in_sale';
const RF = 'refund';

const agg = (
  receipts: TenderBranchAggregate['receipts'] = [],
  refunds: TenderBranchAggregate['refunds'] = [],
  branchId: string = BR,
): TenderBranchAggregate => ({ branchId, receipts, refunds });

const gl = (
  sourceKind: string,
  accountKey: string,
  debit: bigint,
  credit: bigint,
  branchId: string = BR,
): TenderGlAggregate => ({ branchId, sourceKind, accountKey, debit, credit });

const CASH = 'ASSET.CASH_ON_HAND';
const BANK = 'ASSET.BANK';
const CLEARING = 'ASSET.PAYMENT_CLEARING';
const UNAPPLIED = 'LIABILITY.UNAPPLIED_RECEIPTS';
const ADVANCES = 'LIABILITY.CUSTOMER_ADVANCES';

describe('Tender Totals — the pure arithmetic (task 3b.10 Checkpoint C)', () => {
  describe('an empty scope', () => {
    it('is one deterministic zero-filled row per frozen method, zero totals, zero net and eight reconciled controls', () => {
      const b = buildTenderTotalsBlocks(agg(), []);
      expect(b.receipts.byMethod.map((r) => r.method)).toEqual([...TENDER_METHODS]);
      expect(
        b.receipts.byMethod.every((r) => r.receiptCount === 0 && r.receiptTotalMinor === '0'),
      ).toBe(true);
      expect(b.refunds.byMethod.map((r) => r.method)).toEqual([...TENDER_METHODS]);
      expect(
        b.refunds.byMethod.every((r) => r.refundCount === 0 && r.refundTotalMinor === '0'),
      ).toBe(true);
      expect(b.receipts).toMatchObject({ receiptCount: 0, receiptTotalMinor: '0' });
      expect(b.refunds).toMatchObject({ refundCount: 0, refundTotalMinor: '0' });
      expect(b.netTenderMovement.netMovementMinor).toBe('0');
      expect(b.netTenderMovement.byMethod.map((r) => r.method)).toEqual([...TENDER_METHODS]);
      expect(b.reconciliation.reconciled).toBe(true);
      const controls = [
        ...Object.values(b.reconciliation.receipts),
        ...Object.values(b.reconciliation.refunds),
      ];
      expect(controls).toHaveLength(8);
      for (const c of controls) {
        expect(c).toEqual({
          sourceMinor: '0',
          glMinor: '0',
          differenceMinor: '0',
          reconciled: true,
        });
      }
    });

    it('the method set is exactly the frozen TenderMethod vocabulary — five methods, no CREDIT', () => {
      expect([...TENDER_METHODS]).toEqual([
        'CASH',
        'CARD_TERMINAL',
        'BANK_TRANSFER',
        'ONLINE_GATEWAY',
        'OTHER_MANUAL',
      ]);
      const b = buildTenderTotalsBlocks(agg(), []);
      expect(b.receipts.byMethod).toHaveLength(5);
      expect(JSON.stringify(b)).not.toMatch(/CREDIT"/);
    });
  });

  describe('receipts', () => {
    const receipts: TenderBranchAggregate['receipts'] = [
      { stream: 'CUSTOMER', method: 'CASH', count: 2, total: 1_500n },
      { stream: 'ANONYMOUS', method: 'CASH', count: 1, total: 500n },
      { stream: 'CUSTOMER', method: 'BANK_TRANSFER', count: 1, total: 3_000n },
      { stream: 'ANONYMOUS', method: 'OTHER_MANUAL', count: 3, total: 900n },
      { stream: 'CUSTOMER', method: 'CARD_TERMINAL', count: 1, total: 100n },
      { stream: 'CUSTOMER', method: 'ONLINE_GATEWAY', count: 1, total: 250n },
    ];
    const glRows: TenderGlAggregate[] = [
      gl(CR, CASH, 1_500n, 0n),
      gl(WI, CASH, 500n, 0n),
      gl(CR, BANK, 3_000n, 0n),
      gl(WI, CLEARING, 900n, 0n),
      gl(CR, CLEARING, 350n, 0n),
      gl(CR, UNAPPLIED, 0n, 4_850n),
    ];

    it('sums both streams per method, counts each Payment once, never merges methods that share an account', () => {
      const b = buildTenderTotalsBlocks(agg(receipts), glRows);
      const by = Object.fromEntries(b.receipts.byMethod.map((r) => [r.method, r]));
      expect(by['CASH']).toEqual({ method: 'CASH', receiptCount: 3, receiptTotalMinor: '2000' });
      expect(by['BANK_TRANSFER']).toEqual({
        method: 'BANK_TRANSFER',
        receiptCount: 1,
        receiptTotalMinor: '3000',
      });
      expect(by['OTHER_MANUAL']).toEqual({
        method: 'OTHER_MANUAL',
        receiptCount: 3,
        receiptTotalMinor: '900',
      });
      expect(by['CARD_TERMINAL']).toEqual({
        method: 'CARD_TERMINAL',
        receiptCount: 1,
        receiptTotalMinor: '100',
      });
      expect(by['ONLINE_GATEWAY']).toEqual({
        method: 'ONLINE_GATEWAY',
        receiptCount: 1,
        receiptTotalMinor: '250',
      });
      expect(b.receipts.receiptCount).toBe(9);
      expect(b.receipts.receiptTotalMinor).toBe('6250');
    });

    it('methods that share the clearing account share ONE control; each other account has its own', () => {
      const b = buildTenderTotalsBlocks(agg(receipts), glRows);
      expect(b.reconciliation.receipts.cashOnHand).toEqual({
        sourceMinor: '2000',
        glMinor: '2000',
        differenceMinor: '0',
        reconciled: true,
      });
      expect(b.reconciliation.receipts.bank.sourceMinor).toBe('3000');
      // CARD_TERMINAL 100 + ONLINE_GATEWAY 250 + OTHER_MANUAL 900 — one account, one control
      expect(b.reconciliation.receipts.paymentClearing).toEqual({
        sourceMinor: '1250',
        glMinor: '1250',
        differenceMinor: '0',
        reconciled: true,
      });
    });

    it('the unapplied-receipts control is the CUSTOMER stream only — an anonymous walk-in tender never credits it', () => {
      const b = buildTenderTotalsBlocks(agg(receipts), glRows);
      // customer stream: 1 500 + 3 000 + 100 + 250 = 4 850
      expect(b.reconciliation.receipts.unappliedReceipts).toEqual({
        sourceMinor: '4850',
        glMinor: '4850',
        differenceMinor: '0',
        reconciled: true,
      });
    });

    it('a Payment is a receipt once: the figure never depends on how many allocations, advances or settlements exist', () => {
      // the pure input has no allocation / advance / settlement field at all — pinned by the type
      const b = buildTenderTotalsBlocks(
        agg([{ stream: 'CUSTOMER', method: 'CASH', count: 1, total: 700n }]),
        [gl(CR, CASH, 700n, 0n), gl(CR, UNAPPLIED, 0n, 700n)],
      );
      expect(b.receipts.receiptCount).toBe(1);
      expect(b.receipts.receiptTotalMinor).toBe('700');
    });
  });

  describe('refunds and the explicit net movement', () => {
    const refunds: TenderBranchAggregate['refunds'] = [
      { method: 'CASH', accountKey: CASH, count: 2, total: 400n },
      { method: 'BANK_TRANSFER', accountKey: BANK, count: 1, total: 1_000n },
      { method: 'ONLINE_GATEWAY', accountKey: CLEARING, count: 1, total: 250n },
    ];
    const rfGl: TenderGlAggregate[] = [
      gl(RF, CASH, 0n, 400n),
      gl(RF, BANK, 0n, 1_000n),
      gl(RF, CLEARING, 0n, 250n),
      gl(RF, ADVANCES, 1_650n, 0n),
    ];

    it('reports actual refunds separately, per method, zero-filled', () => {
      const b = buildTenderTotalsBlocks(agg([], refunds), rfGl);
      expect(b.refunds.refundCount).toBe(4);
      expect(b.refunds.refundTotalMinor).toBe('1650');
      const by = Object.fromEntries(b.refunds.byMethod.map((r) => [r.method, r]));
      expect(by['CASH']).toEqual({ method: 'CASH', refundCount: 2, refundTotalMinor: '400' });
      expect(by['CARD_TERMINAL']).toEqual({
        method: 'CARD_TERMINAL',
        refundCount: 0,
        refundTotalMinor: '0',
      });
      expect(b.refunds.byMethod).toHaveLength(5);
    });

    it('net movement = receipts − refunds, signed, by method and in total, labelled as tender movement only', () => {
      const b = buildTenderTotalsBlocks(
        agg([{ stream: 'CUSTOMER', method: 'CASH', count: 1, total: 300n }], refunds),
        [gl(CR, CASH, 300n, 0n), gl(CR, UNAPPLIED, 0n, 300n), ...rfGl],
      );
      expect(b.netTenderMovement.netMovementMinor).toBe('-1350'); // 300 − 1 650
      const by = Object.fromEntries(
        b.netTenderMovement.byMethod.map((r) => [r.method, r.netMovementMinor]),
      );
      expect(by).toEqual({
        CASH: '-100', // 300 − 400
        CARD_TERMINAL: '0',
        BANK_TRANSFER: '-1000',
        ONLINE_GATEWAY: '-250',
        OTHER_MANUAL: '0',
      });
      expect(b.netTenderMovement.note).toBe(TENDER_NET_NOTE);
      expect(TENDER_NET_NOTE).toMatch(/not revenue/i);
      expect(TENDER_NET_NOTE).toMatch(/net sales/i);
      expect(TENDER_NET_NOTE).toMatch(/financial result/i);
      expect(TENDER_NET_NOTE).toMatch(/settle/i);
    });

    it('the refund controls: the credit side per cash / bank / clearing account and the customer-advances debit', () => {
      const b = buildTenderTotalsBlocks(agg([], refunds), rfGl);
      expect(b.reconciliation.refunds.cashOnHand.sourceMinor).toBe('400');
      expect(b.reconciliation.refunds.bank.sourceMinor).toBe('1000');
      expect(b.reconciliation.refunds.paymentClearing.sourceMinor).toBe('250');
      expect(b.reconciliation.refunds.customerAdvances).toEqual({
        sourceMinor: '1650',
        glMinor: '1650',
        differenceMinor: '0',
        reconciled: true,
      });
    });
  });

  describe('fail closed', () => {
    it('a receipt control that differs from the GL of its own journals fails the report (500 REPORT_TENDER_GL_MISMATCH)', () => {
      const run = () =>
        buildTenderTotalsBlocks(
          agg([{ stream: 'CUSTOMER', method: 'CASH', count: 1, total: 100n }]),
          [gl(CR, CASH, 99n, 0n), gl(CR, UNAPPLIED, 0n, 100n)],
        );
      expect(run).toThrow(DomainError);
      try {
        run();
      } catch (e) {
        expect(e).toMatchObject({ code: 'REPORT_TENDER_GL_MISMATCH', status: 500 });
      }
    });

    it('a refund control, the unapplied-receipts control and the customer-advances control each fail the report', () => {
      const base = agg(
        [{ stream: 'CUSTOMER', method: 'CASH', count: 1, total: 100n }],
        [{ method: 'CASH', accountKey: CASH, count: 1, total: 40n }],
      );
      const good: TenderGlAggregate[] = [
        gl(CR, CASH, 100n, 0n),
        gl(CR, UNAPPLIED, 0n, 100n),
        gl(RF, CASH, 0n, 40n),
        gl(RF, ADVANCES, 40n, 0n),
      ];
      expect(() => buildTenderTotalsBlocks(base, good)).not.toThrow();
      const bad = (accountKey: string, side: 'debit' | 'credit', sourceKind: string) =>
        good.map((r) =>
          r.sourceKind === sourceKind && r.accountKey === accountKey
            ? { ...r, [side]: r[side] + 1n }
            : r,
        );
      for (const rows of [
        bad(CASH, 'credit', RF),
        bad(UNAPPLIED, 'credit', CR),
        bad(ADVANCES, 'debit', RF),
      ]) {
        expect(() => buildTenderTotalsBlocks(base, rows)).toThrow(/general-ledger|ledger/i);
      }
    });

    it('an unrelated journal kind on a tender account never enters a control (whole-account balances are never used)', () => {
      const b = buildTenderTotalsBlocks(
        agg([{ stream: 'CUSTOMER', method: 'CASH', count: 1, total: 100n }]),
        [
          gl(CR, CASH, 100n, 0n),
          gl(CR, UNAPPLIED, 0n, 100n),
          gl('manual_adjustment', CASH, 9_999n, 0n), // a manual / settlement / unrelated journal on the same account
          gl('SETTLEMENT_BATCH', CLEARING, 0n, 7_000n),
          gl('invoice_ar', CASH, 5n, 0n),
        ],
      );
      expect(b.reconciliation.receipts.cashOnHand).toMatchObject({
        glMinor: '100',
        reconciled: true,
      });
      expect(b.reconciliation.receipts.paymentClearing.glMinor).toBe('0');
    });

    it('a refund journal never counts as a receipt control and a receipt journal never as a refund control', () => {
      const b = buildTenderTotalsBlocks(
        agg(
          [{ stream: 'ANONYMOUS', method: 'CASH', count: 1, total: 100n }],
          [{ method: 'CASH', accountKey: CASH, count: 1, total: 30n }],
        ),
        [gl(WI, CASH, 100n, 0n), gl(RF, CASH, 0n, 30n), gl(RF, ADVANCES, 30n, 0n)],
      );
      expect(b.reconciliation.receipts.cashOnHand.glMinor).toBe('100');
      expect(b.reconciliation.refunds.cashOnHand.glMinor).toBe('30');
    });

    it('an unknown / forbidden method is a RangeError, never a silently dropped row — CREDIT is never a tender', () => {
      for (const method of ['CREDIT', 'cash', '', 'WALLET', 'ADVANCE']) {
        expect(() =>
          buildTenderTotalsBlocks(agg([{ stream: 'CUSTOMER', method, count: 1, total: 1n }]), []),
        ).toThrow(RangeError);
        expect(() =>
          buildTenderTotalsBlocks(agg([], [{ method, accountKey: CASH, count: 1, total: 1n }]), []),
        ).toThrow(RangeError);
      }
    });

    it('a refund whose credit account is unmapped fails closed as a source-integrity error (its own message)', () => {
      try {
        buildTenderTotalsBlocks(
          agg([], [{ method: 'OTHER_MANUAL', accountKey: null, count: 1, total: 5n }]),
          [],
        );
        expect.unreachable('must throw');
      } catch (e) {
        expect(e).toMatchObject({ code: 'REPORT_TENDER_SOURCE_INTEGRITY', status: 500 });
        expect((e as Error).message).toMatch(/no frozen credit-account mapping/);
      }
    });

    it('a refund naming a credit account OUTSIDE the frozen cash / bank / clearing mapping fails closed as a source-integrity error (its own message)', () => {
      for (const accountKey of [ADVANCES, UNAPPLIED, 'REVENUE.SALES', 'ASSET.UNKNOWN']) {
        try {
          buildTenderTotalsBlocks(
            agg([], [{ method: 'CASH', accountKey, count: 1, total: 5n }]),
            [],
          );
          expect.unreachable(`${accountKey} must throw`);
        } catch (e) {
          expect(e).toMatchObject({ code: 'REPORT_TENDER_SOURCE_INTEGRITY', status: 500 });
          expect((e as Error).message).toMatch(/outside the frozen mapping/);
        }
      }
    });

    it('a negative, fractional or non-bigint figure is rejected', () => {
      expect(() =>
        buildTenderTotalsBlocks(
          agg([{ stream: 'CUSTOMER', method: 'CASH', count: 1, total: -1n }]),
          [],
        ),
      ).toThrow(RangeError);
      expect(() =>
        buildTenderTotalsBlocks(
          agg([{ stream: 'CUSTOMER', method: 'CASH', count: 1, total: 1.5 as unknown as bigint }]),
          [],
        ),
      ).toThrow(RangeError);
      expect(() =>
        buildTenderTotalsBlocks(
          agg([{ stream: 'CUSTOMER', method: 'CASH', count: -1, total: 1n }]),
          [],
        ),
      ).toThrow(RangeError);
      expect(() =>
        buildTenderTotalsBlocks(
          agg([{ stream: 'CUSTOMER', method: 'CASH', count: 1.5, total: 1n }]),
          [],
        ),
      ).toThrow(RangeError);
    });
  });

  describe('company = the exact sum of its branches', () => {
    it('sumTenderAggregates adds every branch row; the company blocks equal the field-wise sum of the branch blocks', () => {
      const a = agg(
        [{ stream: 'CUSTOMER', method: 'CASH', count: 2, total: 800n }],
        [{ method: 'CASH', accountKey: CASH, count: 1, total: 100n }],
        BR,
      );
      const c = agg(
        [
          { stream: 'ANONYMOUS', method: 'CASH', count: 1, total: 200n },
          { stream: 'CUSTOMER', method: 'BANK_TRANSFER', count: 1, total: 50n },
        ],
        [{ method: 'BANK_TRANSFER', accountKey: BANK, count: 2, total: 70n }],
        BR2,
      );
      const glA = [
        gl(CR, CASH, 800n, 0n, BR),
        gl(CR, UNAPPLIED, 0n, 800n, BR),
        gl(RF, CASH, 0n, 100n, BR),
        gl(RF, ADVANCES, 100n, 0n, BR),
      ];
      const glB = [
        gl(WI, CASH, 200n, 0n, BR2),
        gl(CR, BANK, 50n, 0n, BR2),
        gl(CR, UNAPPLIED, 0n, 50n, BR2),
        gl(RF, BANK, 0n, 70n, BR2),
        gl(RF, ADVANCES, 70n, 0n, BR2),
      ];
      const bA = buildTenderTotalsBlocks(a, glA);
      const bB = buildTenderTotalsBlocks(c, glB);
      const company = buildTenderTotalsBlocks(sumTenderAggregates('COMPANY', [a, c]), [
        ...glA,
        ...glB,
      ]);
      expect(BigInt(company.receipts.receiptTotalMinor)).toBe(
        BigInt(bA.receipts.receiptTotalMinor) + BigInt(bB.receipts.receiptTotalMinor),
      );
      expect(company.receipts.receiptCount).toBe(
        bA.receipts.receiptCount + bB.receipts.receiptCount,
      );
      expect(BigInt(company.refunds.refundTotalMinor)).toBe(
        BigInt(bA.refunds.refundTotalMinor) + BigInt(bB.refunds.refundTotalMinor),
      );
      expect(BigInt(company.netTenderMovement.netMovementMinor)).toBe(
        BigInt(bA.netTenderMovement.netMovementMinor) +
          BigInt(bB.netTenderMovement.netMovementMinor),
      );
      expect(company.receipts.byMethod.find((r) => r.method === 'CASH')).toEqual({
        method: 'CASH',
        receiptCount: 3,
        receiptTotalMinor: '1000',
      });
    });
  });

  describe('exact money', () => {
    it('amounts beyond Number.MAX_SAFE_INTEGER stay exact decimal strings (KWD, 3 decimals)', () => {
      const big = 9_007_199_254_740_993_000n; // 9 007 199 254 740 993.000 KWD, > 2^53
      const b = buildTenderTotalsBlocks(
        agg([{ stream: 'CUSTOMER', method: 'BANK_TRANSFER', count: 1, total: big }]),
        [gl(CR, BANK, big, 0n), gl(CR, UNAPPLIED, 0n, big)],
      );
      expect(b.receipts.receiptTotalMinor).toBe('9007199254740993000');
      expect(b.netTenderMovement.netMovementMinor).toBe('9007199254740993000');
      expect(typeof b.receipts.receiptTotalMinor).toBe('string');
    });
  });
});
