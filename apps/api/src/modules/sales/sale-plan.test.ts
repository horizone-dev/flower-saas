import { describe, expect, it } from 'vitest';
import {
  assertSalePlanConserved,
  planSale,
  SalePlanError,
  type PlanSaleInput,
  type SalePlan,
  type SalePlanErrorCode,
  type SaleAdvanceRequest,
  type SaleTenderRequest,
} from './sale-plan.js';

/**
 * Task 3b.9 Checkpoint A (A2) — the pure sale-plan validator.
 * The money here is AED (2 dp) unless a test says otherwise.
 */
const CUSTOMER = 'c0000000-0000-7000-8000-000000000001';
const ADV_A = 'a0000000-0000-7000-8000-00000000000a';
const ADV_B = 'a0000000-0000-7000-8000-00000000000b';

const total = (amountMinor: bigint, currencyCode = 'AED', currencyExponent = 2) => ({
  amountMinor,
  currencyCode,
  currencyExponent,
});
const tender = (
  method: string,
  amountMinor: bigint,
  over: Partial<SaleTenderRequest> = {},
): SaleTenderRequest => ({
  method,
  amountMinor,
  currencyCode: 'AED',
  currencyExponent: 2,
  ...over,
});
const advance = (
  advanceId: string,
  amountMinor: bigint,
  over: Partial<SaleAdvanceRequest> = {},
): SaleAdvanceRequest => ({
  advanceId,
  amountMinor,
  currencyCode: 'AED',
  currencyExponent: 2,
  ...over,
});
const input = (over: Partial<PlanSaleInput> = {}): PlanSaleInput => ({
  intent: 'PAY_NOW',
  customerId: null,
  total: total(10_000n),
  tenders: [tender('CASH', 10_000n)],
  advances: [],
  ...over,
});

function codeOf(fn: () => unknown): { code: SalePlanErrorCode; httpStatus: number } {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(SalePlanError);
    expect(e).toBeInstanceOf(RangeError); // the repository's pure-module convention
    return { code: (e as SalePlanError).code, httpStatus: (e as SalePlanError).httpStatus };
  }
  throw new Error('expected planSale to throw');
}
const rejects = (i: PlanSaleInput, code: SalePlanErrorCode, status = 422): void =>
  expect(codeOf(() => planSale(i))).toEqual({ code, httpStatus: status });

describe('planSale — anonymous WALK_IN (customerId = null)', () => {
  it('anonymous CASH: one tender covering the total exactly', () => {
    const p = planSale(input());
    expect(p).toMatchObject({
      intent: 'PAY_NOW',
      customerId: null,
      anonymous: true,
      totalAmountMinor: 10_000n,
      tenderTotalMinor: 10_000n,
      advanceTotalMinor: 0n,
      coveredMinor: 10_000n,
      outstandingMinor: 0n,
      creditGateRequired: false,
      journalPath: 'ANONYMOUS_WALK_IN',
    });
    expect(p.tenders).toEqual([{ method: 'CASH', amountMinor: 10_000n }]);
    expect(p.advances).toEqual([]);
  });

  it('anonymous BANK_TRANSFER', () => {
    const p = planSale(input({ tenders: [tender('BANK_TRANSFER', 10_000n)] }));
    expect(p.tenders).toEqual([{ method: 'BANK_TRANSFER', amountMinor: 10_000n }]);
    expect(p.outstandingMinor).toBe(0n);
  });

  it('anonymous Multi Payment: several tenders, conserved, in REQUEST order', () => {
    const p = planSale(
      input({
        tenders: [
          tender('CARD_TERMINAL', 3_000n),
          tender('CASH', 4_000n),
          tender('BANK_TRANSFER', 3_000n),
        ],
      }),
    );
    expect(p.tenders.map((t) => t.method)).toEqual(['CARD_TERMINAL', 'CASH', 'BANK_TRANSFER']);
    expect(p.tenderTotalMinor).toBe(10_000n);
    expect(p.coveredMinor).toBe(10_000n);
    expect(p.outstandingMinor).toBe(0n);
  });

  it('anonymous ON_CREDIT is rejected — credit requires an identified customer', () => {
    rejects(
      input({ intent: 'ON_CREDIT', tenders: [tender('CASH', 4_000n)] }),
      'SALE_CREDIT_REQUIRES_CUSTOMER',
    );
    rejects(input({ intent: 'ON_CREDIT', tenders: [] }), 'SALE_CREDIT_REQUIRES_CUSTOMER');
  });

  it('anonymous advance is rejected — an advance needs a real customer', () => {
    rejects(
      input({ tenders: [tender('CASH', 6_000n)], advances: [advance(ADV_A, 4_000n)] }),
      'SALE_ADVANCE_REQUIRES_CUSTOMER',
    );
  });

  it('anonymous under-payment is rejected — an anonymous sale must leave zero outstanding', () => {
    rejects(input({ tenders: [tender('CASH', 9_999n)] }), 'SALE_NOT_FULLY_RESOLVED');
    rejects(input({ tenders: [] }), 'SALE_NOT_FULLY_RESOLVED');
  });

  it('anonymous: customerId must be exactly null — a blank id is not "anonymous" and not a customer', () => {
    rejects(input({ customerId: '' }), 'SALE_CUSTOMER_INVALID');
    rejects(input({ customerId: '   ' }), 'SALE_CUSTOMER_INVALID');
  });
});

describe('planSale — identified customer', () => {
  it('customer PAY_NOW: covered exactly, outstanding 0, customer-receivable accounting path', () => {
    const p = planSale(input({ customerId: CUSTOMER }));
    expect(p).toMatchObject({
      anonymous: false,
      customerId: CUSTOMER,
      outstandingMinor: 0n,
      creditGateRequired: false,
      journalPath: 'CUSTOMER_RECEIVABLE',
    });
  });

  it('customer ON_CREDIT with no tender: the whole total is the receivable', () => {
    const p = planSale(input({ customerId: CUSTOMER, intent: 'ON_CREDIT', tenders: [] }));
    expect(p).toMatchObject({
      intent: 'ON_CREDIT',
      coveredMinor: 0n,
      outstandingMinor: 10_000n,
      creditGateRequired: true,
      journalPath: 'CUSTOMER_RECEIVABLE',
    });
    expect(p.tenders).toEqual([]);
  });

  it('customer ON_CREDIT with a partial tender: the remainder is the receivable', () => {
    const p = planSale(
      input({ customerId: CUSTOMER, intent: 'ON_CREDIT', tenders: [tender('CASH', 2_500n)] }),
    );
    expect(p.coveredMinor).toBe(2_500n);
    expect(p.outstandingMinor).toBe(7_500n);
  });

  it('customer advance + tender (PAY_NOW): advance and tender together cover the total exactly', () => {
    const p = planSale(
      input({
        customerId: CUSTOMER,
        tenders: [tender('CASH', 6_000n)],
        advances: [advance(ADV_A, 4_000n)],
      }),
    );
    expect(p.advanceTotalMinor).toBe(4_000n);
    expect(p.tenderTotalMinor).toBe(6_000n);
    expect(p.coveredMinor).toBe(10_000n);
    expect(p.outstandingMinor).toBe(0n);
    expect(p.advances).toEqual([{ advanceId: ADV_A, amountMinor: 4_000n }]);
  });

  it('customer advance only (PAY_NOW, no tender) can cover a sale entirely', () => {
    const p = planSale(
      input({ customerId: CUSTOMER, tenders: [], advances: [advance(ADV_A, 10_000n)] }),
    );
    expect(p.tenders).toEqual([]);
    expect(p.outstandingMinor).toBe(0n);
  });

  it('customer ON_CREDIT with an advance + a tender leaves the exact remainder', () => {
    const p = planSale(
      input({
        customerId: CUSTOMER,
        intent: 'ON_CREDIT',
        tenders: [tender('BANK_TRANSFER', 1_000n)],
        advances: [advance(ADV_A, 2_000n)],
      }),
    );
    expect(p.outstandingMinor).toBe(7_000n);
  });

  it('advances are planned in ASCENDING advanceId order (the canonical lock order), whatever order they were requested in', () => {
    const p = planSale(
      input({
        customerId: CUSTOMER,
        tenders: [],
        advances: [advance(ADV_B, 6_000n), advance(ADV_A, 4_000n)],
      }),
    );
    expect(p.advances.map((a) => a.advanceId)).toEqual([ADV_A, ADV_B]);
  });

  it('the same advance twice is rejected rather than silently merged', () => {
    rejects(
      input({
        customerId: CUSTOMER,
        tenders: [],
        advances: [advance(ADV_A, 5_000n), advance(ADV_A, 5_000n)],
      }),
      'SALE_DUPLICATE_ADVANCE',
    );
  });

  it('a blank advance id is rejected', () => {
    rejects(
      input({ customerId: CUSTOMER, tenders: [], advances: [advance('  ', 10_000n)] }),
      'SALE_ADVANCE_INVALID',
    );
  });
});

describe('planSale — the FULLY-RESOLVED invariant', () => {
  it('PAY_NOW: one minor unit short is rejected, exact is accepted, one over is rejected', () => {
    rejects(input({ tenders: [tender('CASH', 9_999n)] }), 'SALE_NOT_FULLY_RESOLVED');
    expect(planSale(input({ tenders: [tender('CASH', 10_000n)] })).outstandingMinor).toBe(0n);
    rejects(input({ tenders: [tender('CASH', 10_001n)] }), 'SALE_OVERPAYMENT_NOT_ALLOWED');
  });

  it('PAY_NOW over-payment through tenders + advances combined is rejected (no change-making)', () => {
    rejects(
      input({
        customerId: CUSTOMER,
        tenders: [tender('CASH', 6_000n)],
        advances: [advance(ADV_A, 4_001n)],
      }),
      'SALE_OVERPAYMENT_NOT_ALLOWED',
    );
  });

  it('PAY_NOW under-payment through tenders + advances combined is rejected', () => {
    rejects(
      input({
        customerId: CUSTOMER,
        tenders: [tender('CASH', 6_000n)],
        advances: [advance(ADV_A, 3_999n)],
      }),
      'SALE_NOT_FULLY_RESOLVED',
    );
  });

  it('ON_CREDIT: covering the whole total is rejected (that is PAY_NOW), covering all but one unit is accepted', () => {
    rejects(
      input({ customerId: CUSTOMER, intent: 'ON_CREDIT', tenders: [tender('CASH', 10_000n)] }),
      'SALE_ON_CREDIT_FULLY_COVERED',
    );
    const p = planSale(
      input({ customerId: CUSTOMER, intent: 'ON_CREDIT', tenders: [tender('CASH', 9_999n)] }),
    );
    expect(p.outstandingMinor).toBe(1n);
  });

  it('ON_CREDIT: over-coverage is rejected as an overpayment', () => {
    rejects(
      input({ customerId: CUSTOMER, intent: 'ON_CREDIT', tenders: [tender('CASH', 10_001n)] }),
      'SALE_OVERPAYMENT_NOT_ALLOWED',
    );
  });

  it('every accepted plan conserves: tenders + advances = covered, covered + outstanding = total', () => {
    const plans: SalePlan[] = [
      planSale(input()),
      planSale(
        input({
          customerId: CUSTOMER,
          tenders: [tender('CASH', 1n)],
          advances: [advance(ADV_A, 9_999n)],
        }),
      ),
      planSale(input({ customerId: CUSTOMER, intent: 'ON_CREDIT', tenders: [] })),
      planSale(
        input({
          customerId: CUSTOMER,
          intent: 'ON_CREDIT',
          tenders: [tender('CASH', 3n), tender('BANK_TRANSFER', 4n)],
        }),
      ),
    ];
    for (const p of plans) {
      expect(p.tenderTotalMinor + p.advanceTotalMinor).toBe(p.coveredMinor);
      expect(p.coveredMinor + p.outstandingMinor).toBe(p.totalAmountMinor);
      expect(p.tenders.reduce((a, t) => a + t.amountMinor, 0n)).toBe(p.tenderTotalMinor);
      expect(p.advances.reduce((a, t) => a + t.amountMinor, 0n)).toBe(p.advanceTotalMinor);
      expect(p.intent === 'PAY_NOW' ? p.outstandingMinor === 0n : p.outstandingMinor > 0n).toBe(
        true,
      );
      expect(() => assertSalePlanConserved(p)).not.toThrow();
    }
  });

  it('assertSalePlanConserved: each backstop check fires ON ITS OWN (every corruption is isolated to one invariant)', () => {
    const credit = planSale(
      input({ customerId: CUSTOMER, intent: 'ON_CREDIT', tenders: [tender('CASH', 2_500n)] }),
    ); // covered 2,500, outstanding 7,500, total 10,000
    /** the message lists every violated clause after the colon, `; `-separated */
    const clauses = (c: Partial<SalePlan>): string[] => {
      try {
        assertSalePlanConserved({ ...credit, ...c });
      } catch (e) {
        return (e as SalePlanError).message.replace(/^[^:]*: /, '').split('; ');
      }
      return [];
    };
    expect(clauses({ outstandingMinor: 7_499n })).toEqual(['covered + outstanding != total']);
    // outstanding is moved with it, so covered + outstanding still equals the total
    expect(clauses({ coveredMinor: 2_499n, outstandingMinor: 7_501n })).toEqual([
      'covered != tenders + advances',
    ]);
    expect(
      clauses({ tenderTotalMinor: 2_501n, coveredMinor: 2_501n, outstandingMinor: 7_499n }),
    ).toEqual(['tender total != sum of tenders']);
    expect(
      clauses({ advanceTotalMinor: 1n, coveredMinor: 2_501n, outstandingMinor: 7_499n }),
    ).toEqual(['advance total != sum of advances']);
    expect(clauses({ anonymous: true })).toEqual(['an anonymous sale is PAY_NOW with no advance']);
    // intent relabelled: a fully covered customer plan called ON_CREDIT / an ON_CREDIT plan called PAY_NOW
    const paid = planSale(input({ customerId: CUSTOMER }));
    expect(() => assertSalePlanConserved({ ...paid, intent: 'ON_CREDIT' })).toThrow(
      /^sale plan is not conserved: ON_CREDIT leaves no outstanding balance$/,
    );
    expect(() => assertSalePlanConserved({ ...credit, intent: 'PAY_NOW' })).toThrow(
      /^sale plan is not conserved: PAY_NOW leaves an outstanding balance$/,
    );
  });

  it('assertSalePlanConserved rejects a hand-corrupted plan (the backstop is real)', () => {
    const good = planSale(input());
    const corruptions: Partial<SalePlan>[] = [
      { tenderTotalMinor: good.tenderTotalMinor + 1n },
      { coveredMinor: good.coveredMinor - 1n },
      { outstandingMinor: 1n },
      { advanceTotalMinor: 5n },
    ];
    for (const c of corruptions) {
      expect(codeOf(() => assertSalePlanConserved({ ...good, ...c }))).toEqual({
        code: 'SALE_PLAN_INVARIANT_VIOLATED',
        httpStatus: 500,
      });
    }
    expect(() =>
      assertSalePlanConserved({ ...good, intent: 'ON_CREDIT', outstandingMinor: 0n }),
    ).toThrow(SalePlanError);
    expect(() =>
      assertSalePlanConserved({
        ...good,
        anonymous: true,
        intent: 'ON_CREDIT',
        outstandingMinor: 1n,
        coveredMinor: good.coveredMinor - 1n,
        tenderTotalMinor: good.tenderTotalMinor - 1n,
        tenders: [{ method: 'CASH', amountMinor: good.tenderTotalMinor - 1n }],
      }),
    ).toThrow(/anonymous/);
  });

  it('a zero-value sale is not supported (no journal can be posted for it) — and a negative one is invalid', () => {
    rejects(input({ total: total(0n), tenders: [] }), 'SALE_ZERO_TOTAL_NOT_SUPPORTED');
    rejects(input({ total: total(-5n), tenders: [] }), 'SALE_TOTAL_INVALID');
  });

  it('the intent must be exactly PAY_NOW or ON_CREDIT', () => {
    for (const bad of ['CREDIT', 'pay_now', '', 'ADVANCE', 'PAY_LATER']) {
      rejects(input({ intent: bad }), 'SALE_INTENT_INVALID');
    }
  });
});

describe('planSale — the supported / rejected tender matrix', () => {
  const supported: [string, string | null][] = [
    ['CASH', null],
    ['BANK_TRANSFER', null],
    ['OTHER_MANUAL', null],
    ['CARD_TERMINAL', null], // the manual terminal slip (no provider credential)
  ];
  it.each(supported)('accepts %s (provider credential: %s)', (method, cred) => {
    const p = planSale(
      input({ tenders: [tender(method, 10_000n, { providerCredentialId: cred })] }),
    );
    expect(p.tenders[0]!.method).toBe(method);
  });

  const providerBacked: [string, string | null][] = [
    ['ONLINE_GATEWAY', null],
    ['ONLINE_GATEWAY', 'cred-1'],
    ['CARD_TERMINAL', 'cred-1'], // an integrated / networked terminal
  ];
  it.each(providerBacked)(
    'rejects provider-backed %s (credential %s) — no provider I/O in an atomic sale',
    (method, cred) => {
      rejects(
        input({ tenders: [tender(method, 10_000n, { providerCredentialId: cred })] }),
        'PAYMENT_ASYNC_TENDER_NOT_ALLOWED_IN_ATOMIC_MULTI_PAYMENT',
      );
    },
  );

  const notTenders = [
    'CREDIT',
    'ADVANCE',
    'WALLET',
    'STORE_CREDIT',
    'LOYALTY',
    'GIFT_CARD',
    'REFUND',
    'cash',
    '',
    ' CASH',
  ];
  it.each(notTenders)(
    'rejects %j — credit, advances and unknown values are never tenders',
    (method) => {
      rejects(input({ tenders: [tender(method, 10_000n)] }), 'SALE_TENDER_METHOD_UNSUPPORTED');
    },
  );

  it('one provider-backed tender poisons a Multi Payment even when the others are valid', () => {
    rejects(
      input({ tenders: [tender('CASH', 5_000n), tender('ONLINE_GATEWAY', 5_000n)] }),
      'PAYMENT_ASYNC_TENDER_NOT_ALLOWED_IN_ATOMIC_MULTI_PAYMENT',
    );
  });

  it('mixed supported local tenders combine (CASH + BANK_TRANSFER + OTHER_MANUAL + manual CARD_TERMINAL)', () => {
    const p = planSale(
      input({
        tenders: [
          tender('CASH', 1_000n),
          tender('BANK_TRANSFER', 2_000n),
          tender('OTHER_MANUAL', 3_000n),
          tender('CARD_TERMINAL', 4_000n),
        ],
      }),
    );
    expect(p.tenderTotalMinor).toBe(10_000n);
  });
});

describe('planSale — positive exact money (zero / negative / non-BigInt)', () => {
  it('rejects a zero tender and a negative tender', () => {
    rejects(
      input({ tenders: [tender('CASH', 0n), tender('CASH', 10_000n)] }),
      'PAYMENT_INVALID_AMOUNT',
    );
    rejects(
      input({ tenders: [tender('CASH', -1n), tender('CASH', 10_001n)] }),
      'PAYMENT_INVALID_AMOUNT',
    );
  });

  it('rejects a zero / negative advance application', () => {
    rejects(
      input({
        customerId: CUSTOMER,
        tenders: [tender('CASH', 10_000n)],
        advances: [advance(ADV_A, 0n)],
      }),
      'PAYMENT_INVALID_AMOUNT',
    );
    rejects(
      input({
        customerId: CUSTOMER,
        tenders: [tender('CASH', 10_000n)],
        advances: [advance(ADV_A, -1n)],
      }),
      'PAYMENT_INVALID_AMOUNT',
    );
  });

  it('rejects a non-BigInt amount: no JS number can ever carry money here', () => {
    const asNumber = 10_000 as unknown as bigint;
    rejects(input({ tenders: [tender('CASH', asNumber)] }), 'PAYMENT_INVALID_AMOUNT');
    rejects(input({ total: total(10_000 as unknown as bigint) }), 'SALE_TOTAL_INVALID');
    rejects(
      input({ customerId: CUSTOMER, tenders: [], advances: [advance(ADV_A, asNumber)] }),
      'PAYMENT_INVALID_AMOUNT',
    );
  });
});

describe('planSale — currency / exponent exactness', () => {
  it('a tender in another currency or another exponent is rejected', () => {
    rejects(
      input({ tenders: [tender('CASH', 10_000n, { currencyCode: 'SAR' })] }),
      'PAYMENT_CURRENCY_MISMATCH',
    );
    rejects(
      input({ tenders: [tender('CASH', 10_000n, { currencyExponent: 3 })] }),
      'PAYMENT_CURRENCY_MISMATCH',
    );
  });

  it('an advance in another currency or exponent is rejected', () => {
    rejects(
      input({
        customerId: CUSTOMER,
        tenders: [],
        advances: [advance(ADV_A, 10_000n, { currencyCode: 'USD' })],
      }),
      'PAYMENT_CURRENCY_MISMATCH',
    );
    rejects(
      input({
        customerId: CUSTOMER,
        tenders: [],
        advances: [advance(ADV_A, 10_000n, { currencyExponent: 3 })],
      }),
      'PAYMENT_CURRENCY_MISMATCH',
    );
  });

  it('3-decimal currencies (KWD / BHD / OMR) plan exactly, in minor units of 1/1000', () => {
    for (const code of ['KWD', 'BHD', 'OMR']) {
      const p = planSale({
        intent: 'PAY_NOW',
        customerId: null,
        total: total(3_750n, code, 3),
        tenders: [
          { method: 'CASH', amountMinor: 1_250n, currencyCode: code, currencyExponent: 3 },
          { method: 'BANK_TRANSFER', amountMinor: 2_500n, currencyCode: code, currencyExponent: 3 },
        ],
        advances: [],
      });
      expect(p.currencyCode).toBe(code);
      expect(p.currencyExponent).toBe(3);
      expect(p.outstandingMinor).toBe(0n);
    }
  });

  it('a 2-decimal tender cannot settle a 3-decimal sale (and vice-versa) — no implicit conversion', () => {
    rejects(
      {
        intent: 'PAY_NOW',
        customerId: null,
        total: total(3_750n, 'KWD', 3),
        tenders: [tender('CASH', 3_750n)], // AED / 2
        advances: [],
      },
      'PAYMENT_CURRENCY_MISMATCH',
    );
  });

  it('the sale total itself must be a known currency with its true exponent', () => {
    rejects(input({ total: total(10_000n, 'XXX', 2) }), 'SALE_TOTAL_INVALID');
    rejects(input({ total: total(10_000n, 'AED', 3) }), 'SALE_TOTAL_INVALID');
    rejects(input({ total: total(10_000n, 'KWD', 2) }), 'SALE_TOTAL_INVALID');
  });
});

describe('planSale — determinism and purity', () => {
  it('is deterministic: the same input always yields the same plan', () => {
    const i = input({
      customerId: CUSTOMER,
      tenders: [tender('CASH', 4_000n)],
      advances: [advance(ADV_B, 3_000n), advance(ADV_A, 3_000n)],
    });
    const first = planSale(i);
    for (let n = 0; n < 25; n += 1) expect(planSale(i)).toEqual(first);
  });

  it('never mutates its input (including the advance array it sorts a COPY of)', () => {
    const advances = [advance(ADV_B, 3_000n), advance(ADV_A, 3_000n)];
    const i = input({ customerId: CUSTOMER, tenders: [tender('CASH', 4_000n)], advances });
    planSale(i);
    expect(advances.map((a) => a.advanceId)).toEqual([ADV_B, ADV_A]);
  });

  it('returns a frozen plan (the orchestrator cannot edit it into something invalid)', () => {
    const p = planSale(input());
    expect(Object.isFrozen(p)).toBe(true);
    expect(Object.isFrozen(p.tenders)).toBe(true);
    expect(Object.isFrozen(p.advances)).toBe(true);
  });

  it('error precedence is deterministic: intent, then total, then customer rules, then tenders, then advances, then coverage', () => {
    // intent beats everything
    rejects(
      input({ intent: 'NOPE', total: total(0n), tenders: [tender('CREDIT', 1n)] }),
      'SALE_INTENT_INVALID',
    );
    // a bad total beats a bad tender
    rejects(
      input({ total: total(0n), tenders: [tender('CREDIT', 1n)] }),
      'SALE_ZERO_TOTAL_NOT_SUPPORTED',
    );
    // anonymous credit beats a bad tender
    rejects(
      input({ intent: 'ON_CREDIT', tenders: [tender('CREDIT', 1n)] }),
      'SALE_CREDIT_REQUIRES_CUSTOMER',
    );
    // a provider-backed tender beats a zero amount on the same tender
    rejects(
      input({ tenders: [tender('ONLINE_GATEWAY', 0n)] }),
      'PAYMENT_ASYNC_TENDER_NOT_ALLOWED_IN_ATOMIC_MULTI_PAYMENT',
    );
  });
});
