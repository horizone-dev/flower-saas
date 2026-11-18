import { describe, expect, it } from 'vitest';
import {
  RECEIVABLE_AGE_NOTE,
  creditSaveMessage,
  creditStateLabel,
  owingCustomers,
  creditUtilisation,
  planCreditChange,
  receivableAgeLabel,
  receivableStatus,
  statementLabel,
} from './customer-credit';

describe('planCreditChange — turns the form into the strict wire body (advisory only; the server decides)', () => {
  it('enable with a limit sends the limit in minor units for the company currency exponent', () => {
    expect(planCreditChange({ enabled: true, limitText: '2,500.50', exponent: 2 })).toEqual({
      ok: true,
      input: { creditEnabled: true, creditLimitMinor: '250050' },
    });
    expect(planCreditChange({ enabled: true, limitText: '12.345', exponent: 3 })).toEqual({
      ok: true,
      input: { creditEnabled: true, creditLimitMinor: '12345' },
    });
  });

  it('a blank limit sends NO limit key at all (the server keeps the stored one; there is no clear verb)', () => {
    const plan = planCreditChange({ enabled: false, limitText: '   ', exponent: 2 });
    expect(plan).toEqual({ ok: true, input: { creditEnabled: false } });
    if (plan.ok) expect(Object.keys(plan.input)).toEqual(['creditEnabled']);
  });

  it('refuses a zero, negative, malformed or over-precise limit before any request', () => {
    for (const bad of ['0', '0.00', '-5', 'abc', '1,2', '12.505']) {
      const plan = planCreditChange({ enabled: true, limitText: bad, exponent: 2 });
      expect(plan.ok, bad).toBe(false);
    }
  });

  it('never produces a floating point number: a huge amount stays an exact digit string', () => {
    const plan = planCreditChange({
      enabled: true,
      limitText: '90071992547409.93',
      exponent: 2,
    });
    expect(plan).toEqual({
      ok: true,
      input: { creditEnabled: true, creditLimitMinor: '9007199254740993' },
    });
  });
});

describe('creditUtilisation — a DISPLAY ratio of the server exposure to the server limit', () => {
  it('no limit stored means no ceiling, never a percentage', () => {
    expect(creditUtilisation({ enabled: true, limitMinor: null, exposureMinor: '5000' })).toEqual({
      state: 'NO_CEILING',
      percent: null,
    });
  });
  it('credit switched off is reported as off whatever the figures are', () => {
    expect(creditUtilisation({ enabled: false, limitMinor: '10000', exposureMinor: '0' })).toEqual({
      state: 'OFF',
      percent: null,
    });
  });
  it('within, at and over the limit', () => {
    expect(
      creditUtilisation({ enabled: true, limitMinor: '10000', exposureMinor: '2500' }),
    ).toEqual({
      state: 'WITHIN',
      percent: '25.0',
    });
    expect(
      creditUtilisation({ enabled: true, limitMinor: '10000', exposureMinor: '10000' }),
    ).toEqual({
      state: 'AT_OR_OVER',
      percent: '100.0',
    });
    expect(
      creditUtilisation({ enabled: true, limitMinor: '10000', exposureMinor: '12500' }),
    ).toEqual({
      state: 'AT_OR_OVER',
      percent: '125.0',
    });
  });
});

describe('creditStateLabel', () => {
  it('says what the till will do, in plain words', () => {
    expect(creditStateLabel({ enabled: false, limitMinor: null })).toBe('Credit is OFF');
    expect(creditStateLabel({ enabled: true, limitMinor: null })).toBe(
      'Credit is ON — no limit set',
    );
    expect(creditStateLabel({ enabled: true, limitMinor: '100' })).toBe(
      'Credit is ON — with a limit',
    );
  });
});

describe('creditSaveMessage — one clear sentence per server refusal', () => {
  it('names a stale version and tells the owner to reload', () => {
    expect(creditSaveMessage('CUSTOMER_CREDIT_VERSION_CONFLICT', 409)).toMatch(/changed.*reload/i);
  });
  it('names the missing authority for a permission refusal', () => {
    const m = creditSaveMessage('MISSING_PERMISSION', 403);
    expect(m).toMatch(/permission/i);
    expect(m).toMatch(/credit/i);
  });
  it('explains the other credit refusals', () => {
    expect(creditSaveMessage('CUSTOMER_CREDIT_LIMIT_INVALID', 422)).toMatch(/positive/i);
    expect(creditSaveMessage('CUSTOMER_CREDIT_CURRENCY_MISMATCH', 409)).toMatch(/currency/i);
    expect(creditSaveMessage('CUSTOMER_COMPANY_ACCOUNT_NOT_FOUND', 404)).toMatch(
      /not found|company/i,
    );
    expect(creditSaveMessage('IMPERSONATION_READ_ONLY', 403)).toMatch(/read-only/i);
  });
  it('falls back to the server code so nothing is hidden', () => {
    expect(creditSaveMessage('SOMETHING_NEW', 500)).toContain('SOMETHING_NEW');
  });
});

describe('receivableAgeLabel — age since the source date; there is NO due date or terms, so never "overdue"', () => {
  it('formats the age and never uses the word overdue', () => {
    expect(receivableAgeLabel(0)).toBe('today');
    expect(receivableAgeLabel(1)).toBe('1 day');
    expect(receivableAgeLabel(45)).toBe('45 days');
    expect(`${receivableAgeLabel(45)} ${RECEIVABLE_AGE_NOTE}`).not.toMatch(/overdue (by|since)/i);
  });
  it('the page note says plainly that overdue is not available', () => {
    expect(RECEIVABLE_AGE_NOTE).toMatch(/no due date/i);
  });
});

describe('receivableStatus and statementLabel — plain words from the server figures and kinds', () => {
  it('UNPAID when nothing was paid on it, PART PAID when some was', () => {
    expect(receivableStatus({ originalAmountMinor: '1000', outstandingMinor: '1000' })).toBe(
      'UNPAID',
    );
    expect(receivableStatus({ originalAmountMinor: '1000', outstandingMinor: '400' })).toBe(
      'PART PAID',
    );
  });
  it('names the statement kinds the owner needs to read a payment history', () => {
    expect(statementLabel('PAYMENT_ALLOCATION')).toBe('Payment applied to invoice');
    expect(statementLabel('ADVANCE')).toBe('Advance received');
    expect(statementLabel('INVOICE')).toBe('Invoice');
  });
  it('a kind with no wording is shown from its own name, never hidden', () => {
    expect(statementLabel('SOME_NEW_KIND')).toBe('Some new kind');
  });
});

describe('owingCustomers — display order of one report page (the server pages by customer id, not by amount)', () => {
  const row = (customerId: string, outstandingMinor: string) => ({
    customerId,
    receivableCount: 1,
    originalMinor: outstandingMinor,
    paidByPaymentMinor: '0',
    paidByAdvanceMinor: '0',
    creditedMinor: '0',
    outstandingMinor,
  });
  it('keeps only customers who owe something, largest balance first, with exact integer comparison', () => {
    const rows = [
      row('a', '0'),
      row('b', '900'),
      row('c', '9007199254740993'),
      row('d', '9007199254740992'),
    ];
    expect(owingCustomers(rows).map((r) => r.customerId)).toEqual(['c', 'd', 'b']);
  });
  it('does not mutate the page it was given', () => {
    const rows = [row('a', '1'), row('b', '2')];
    owingCustomers(rows);
    expect(rows.map((r) => r.customerId)).toEqual(['a', 'b']);
  });
});
