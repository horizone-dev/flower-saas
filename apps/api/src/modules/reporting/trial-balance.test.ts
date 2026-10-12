import { describe, expect, it } from 'vitest';
import { DomainError } from '../../common/errors/domain-error.js';
import {
  assertTrialBalanceBalanced,
  buildTrialBalance,
  placeNetOnSide,
  type TrialBalanceAccountAggregate,
} from './trial-balance.js';

function acct(
  key: string,
  v: { od?: bigint; oc?: bigint; pd?: bigint; pc?: bigint },
): TrialBalanceAccountAggregate {
  return {
    accountId: `id-${key}`,
    accountKey: key,
    category: key.split('.')[0]!,
    displayCode: key,
    displayName: key,
    openingDebitMinor: v.od ?? 0n,
    openingCreditMinor: v.oc ?? 0n,
    periodDebitMinor: v.pd ?? 0n,
    periodCreditMinor: v.pc ?? 0n,
  };
}

function unbalanced(rows: TrialBalanceAccountAggregate[]): DomainError {
  try {
    buildTrialBalance(rows);
  } catch (e) {
    if (e instanceof DomainError) return e;
    throw e;
  }
  throw new Error('expected a DomainError');
}

describe('placeNetOnSide — a signed net exists only internally', () => {
  it('a non-negative net is a debit; a negative net is its absolute value as a credit', () => {
    expect(placeNetOnSide(500n)).toEqual({ debit: 500n, credit: 0n });
    expect(placeNetOnSide(0n)).toEqual({ debit: 0n, credit: 0n });
    expect(placeNetOnSide(-500n)).toEqual({ debit: 0n, credit: 500n });
  });
});

describe('buildTrialBalance — the exact opening / period / closing algorithm', () => {
  // Ledger: opening entry  Dr CASH 1000 / Cr ADV 1000
  //         period entry   Dr CASH 300  / Cr REVENUE 300
  //         period entry   Dr EXPENSE 200 / Cr CASH 200
  const base = [
    acct('ASSET.CASH', { od: 1000n, pd: 300n, pc: 200n }),
    acct('LIABILITY.ADV', { oc: 1000n }),
    acct('REVENUE.SALES', { pc: 300n }),
    acct('EXPENSE.FEE', { pd: 200n }),
  ];

  it('opening = Σdebit − Σcredit before `from`; closing = opening + periodDebit − periodCredit', () => {
    const { accounts } = buildTrialBalance(base);
    const by = Object.fromEntries(accounts.map((a) => [a.accountKey, a]));
    // asset debit balance
    expect(by['ASSET.CASH']).toMatchObject({
      openingDebitMinor: '1000',
      openingCreditMinor: '0',
      periodDebitMinor: '300',
      periodCreditMinor: '200',
      closingDebitMinor: '1100',
      closingCreditMinor: '0',
    });
    // liability credit balance, untouched by the period
    expect(by['LIABILITY.ADV']).toMatchObject({
      openingDebitMinor: '0',
      openingCreditMinor: '1000',
      closingDebitMinor: '0',
      closingCreditMinor: '1000',
    });
    // revenue credit balance, born in the period
    expect(by['REVENUE.SALES']).toMatchObject({
      openingDebitMinor: '0',
      openingCreditMinor: '0',
      periodCreditMinor: '300',
      closingDebitMinor: '0',
      closingCreditMinor: '300',
    });
    // expense debit balance
    expect(by['EXPENSE.FEE']).toMatchObject({
      closingDebitMinor: '200',
      closingCreditMinor: '0',
    });
  });

  it('control totals: opening, period and closing each balance', () => {
    expect(buildTrialBalance(base).totals).toEqual({
      totalOpeningDebitMinor: '1000',
      totalOpeningCreditMinor: '1000',
      totalPeriodDebitMinor: '500',
      totalPeriodCreditMinor: '500',
      totalClosingDebitMinor: '1300',
      totalClosingCreditMinor: '1300',
    });
  });

  it('an account can reverse sign across the period (both directions)', () => {
    // X: opening 500 Dr, period credit 800  → closing 300 CREDIT
    // Y: opening 500 Cr, period debit 800   → closing 300 DEBIT
    const { accounts, totals } = buildTrialBalance([
      acct('ASSET.X', { od: 500n, pc: 800n }),
      acct('LIABILITY.Y', { oc: 500n, pd: 800n }),
    ]);
    expect(accounts[0]).toMatchObject({
      openingDebitMinor: '500',
      openingCreditMinor: '0',
      closingDebitMinor: '0',
      closingCreditMinor: '300',
    });
    expect(accounts[1]).toMatchObject({
      openingDebitMinor: '0',
      openingCreditMinor: '500',
      closingDebitMinor: '300',
      closingCreditMinor: '0',
    });
    expect(totals.totalClosingDebitMinor).toBe('300');
    expect(totals.totalClosingCreditMinor).toBe('300');
  });

  it('period debit and credit are returned as they are — never netted into one figure', () => {
    const { accounts } = buildTrialBalance([
      acct('ASSET.CASH', { pd: 700n, pc: 700n }),
      acct('REVENUE.SALES', { pd: 50n, pc: 50n }),
    ]);
    expect(accounts[0]).toMatchObject({
      periodDebitMinor: '700',
      periodCreditMinor: '700',
      closingDebitMinor: '0',
      closingCreditMinor: '0',
    });
  });

  it('keeps the caller-supplied (deterministic) order and returns every row, however many', () => {
    const rows = ['9', '2', '5', '1'].map((n) => acct(`ASSET.A${n}`, {}));
    expect(buildTrialBalance(rows).accounts.map((a) => a.accountKey)).toEqual(
      rows.map((r) => r.accountKey),
    );
    expect(buildTrialBalance([]).accounts).toEqual([]);
    expect(buildTrialBalance([]).totals.totalClosingDebitMinor).toBe('0');
  });

  it('is exact beyond Number.MAX_SAFE_INTEGER (bigint arithmetic, string output, no number conversion)', () => {
    const big = 9_007_199_254_740_993n; // 2^53 + 1
    const { accounts, totals } = buildTrialBalance([
      acct('ASSET.CASH', { od: big, pd: big, pc: 1n }),
      acct('LIABILITY.ADV', { oc: big, pc: big - 1n }),
    ]);
    expect(accounts[0]).toMatchObject({
      openingDebitMinor: '9007199254740993',
      closingDebitMinor: '18014398509481985',
    });
    expect(totals.totalClosingDebitMinor).toBe('18014398509481985');
    expect(totals.totalClosingCreditMinor).toBe('18014398509481985');
    for (const a of accounts) {
      for (const v of [
        a.openingDebitMinor,
        a.openingCreditMinor,
        a.periodDebitMinor,
        a.periodCreditMinor,
        a.closingDebitMinor,
        a.closingCreditMinor,
      ]) {
        expect(typeof v).toBe('string');
        expect(v).toMatch(/^\d+$/);
      }
    }
  });

  it('rejects a negative sum (a corrupted aggregate is never normalised)', () => {
    expect(() => buildTrialBalance([acct('ASSET.X', { od: -1n })])).toThrow(RangeError);
    expect(() => buildTrialBalance([acct('ASSET.X', { pc: -1n })])).toThrow(RangeError);
    expect(() =>
      buildTrialBalance([{ ...acct('ASSET.X', {}), periodDebitMinor: 5 as unknown as bigint }]),
    ).toThrow(RangeError);
  });
});

describe('the control-total invariant FAILS CLOSED', () => {
  it('an unbalanced PERIOD is REPORT_TRIAL_BALANCE_UNBALANCED (500) — no figures are returned', () => {
    const err = unbalanced([acct('ASSET.CASH', { pd: 100n }), acct('REVENUE.SALES', { pc: 99n })]);
    expect(err.code).toBe('REPORT_TRIAL_BALANCE_UNBALANCED');
    expect(err.status).toBe(500);
    expect(err.message).toContain('period');
  });

  it('an unbalanced OPENING is rejected', () => {
    const err = unbalanced([acct('ASSET.CASH', { od: 100n }), acct('REVENUE.SALES', { oc: 1n })]);
    expect(err.code).toBe('REPORT_TRIAL_BALANCE_UNBALANCED');
    expect(err.message).toContain('opening');
  });

  it('a balanced window passes the guard; a closing-only imbalance is also caught', () => {
    expect(() =>
      assertTrialBalanceBalanced({
        openingDebit: 5n,
        openingCredit: 5n,
        periodDebit: 7n,
        periodCredit: 7n,
        closingDebit: 12n,
        closingCredit: 12n,
      }),
    ).not.toThrow();
    expect(() =>
      assertTrialBalanceBalanced({
        openingDebit: 5n,
        openingCredit: 5n,
        periodDebit: 7n,
        periodCredit: 7n,
        closingDebit: 12n,
        closingCredit: 11n,
      }),
    ).toThrow(DomainError);
  });
});
