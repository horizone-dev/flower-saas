import { describe, expect, it } from 'vitest';
import { DomainError } from '../../common/errors/domain-error.js';
import {
  coverageSourceOfApplication,
  type ApplicationCoverageRow,
} from './credit-note-coverage-source.js';

/**
 * Task 3b.8 F3 — the release shape of ONE `CustomerAdvanceApplication` coverage source, by the
 * provenance of the advance it drew on. Pure: no DB, no HTTP. The rule under test: a
 * CREDIT_NOTE-sourced advance has no Payment of its own, so its release provenance is derived ONLY
 * from the authoritative funding release that created it — never invented, never guessed, never
 * taken from the advance row; anything missing or inconsistent fails closed.
 */
const PAYMENT_P = '11111111-1111-7111-8111-111111111111';
const PAYMENT_Q = '22222222-2222-7222-8222-222222222222';

const row = (over: Partial<ApplicationCoverageRow>): ApplicationCoverageRow => ({
  id: 'app-1',
  amountMinor: 600n,
  advanceSourceType: 'PAYMENT',
  advanceSourcePaymentId: PAYMENT_P,
  fundingKind: null,
  fundingPaymentId: null,
  ...over,
});

describe('coverageSourceOfApplication (task 3b.8 F3 — release provenance of an application)', () => {
  it("a PAYMENT-sourced advance -> ADVANCE_APPLICATION carrying that advance's own payment (unchanged)", () => {
    expect(coverageSourceOfApplication(row({}))).toEqual({
      sourceKind: 'ADVANCE_APPLICATION',
      sourcePaymentAllocationId: null,
      sourceAdvanceApplicationId: 'app-1',
      sourcePaymentId: PAYMENT_P,
      amountMinor: 600n,
    });
  });

  it('an OPENING-sourced advance -> OPENING_ADVANCE with NO payment (unchanged)', () => {
    expect(
      coverageSourceOfApplication(
        row({ advanceSourceType: 'OPENING', advanceSourcePaymentId: null }),
      ),
    ).toEqual({
      sourceKind: 'OPENING_ADVANCE',
      sourcePaymentAllocationId: null,
      sourceAdvanceApplicationId: 'app-1',
      sourcePaymentId: null,
      amountMinor: 600n,
    });
  });

  it('a CREDIT_NOTE advance funded from a PAYMENT_ALLOCATION release -> ADVANCE_APPLICATION with the ULTIMATE payment of that funding release', () => {
    expect(
      coverageSourceOfApplication(
        row({
          advanceSourceType: 'CREDIT_NOTE',
          advanceSourcePaymentId: null,
          fundingKind: 'PAYMENT_ALLOCATION',
          fundingPaymentId: PAYMENT_P,
        }),
      ),
    ).toMatchObject({ sourceKind: 'ADVANCE_APPLICATION', sourcePaymentId: PAYMENT_P });
  });

  it('a CREDIT_NOTE advance funded from an ADVANCE_APPLICATION release (depth 2) -> carries the SAME ultimate payment forward, never flattened or re-derived', () => {
    expect(
      coverageSourceOfApplication(
        row({
          advanceSourceType: 'CREDIT_NOTE',
          advanceSourcePaymentId: null,
          fundingKind: 'ADVANCE_APPLICATION',
          fundingPaymentId: PAYMENT_Q,
        }),
      ),
    ).toMatchObject({ sourceKind: 'ADVANCE_APPLICATION', sourcePaymentId: PAYMENT_Q });
  });

  it('a CREDIT_NOTE advance funded from an OPENING_ADVANCE release -> OPENING_ADVANCE with NO payment (a Payment id is never fabricated)', () => {
    expect(
      coverageSourceOfApplication(
        row({
          advanceSourceType: 'CREDIT_NOTE',
          advanceSourcePaymentId: null,
          fundingKind: 'OPENING_ADVANCE',
          fundingPaymentId: null,
        }),
      ),
    ).toMatchObject({ sourceKind: 'OPENING_ADVANCE', sourcePaymentId: null });
  });

  it("a CREDIT_NOTE advance's provenance comes ONLY from the funding release — a stray payment id on the advance row itself is ignored", () => {
    expect(
      coverageSourceOfApplication(
        row({
          advanceSourceType: 'CREDIT_NOTE',
          advanceSourcePaymentId: PAYMENT_Q, // not a legitimate state — must never be used
          fundingKind: 'PAYMENT_ALLOCATION',
          fundingPaymentId: PAYMENT_P,
        }),
      ),
    ).toMatchObject({ sourcePaymentId: PAYMENT_P });
  });

  describe('fails closed — a clean domain error, never a guess', () => {
    const unresolved = (r: ApplicationCoverageRow): void => {
      let thrown: unknown;
      try {
        coverageSourceOfApplication(r);
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(DomainError);
      expect(thrown).toMatchObject({
        code: 'CREDIT_NOTE_ADVANCE_PROVENANCE_UNRESOLVED',
        status: 409,
      });
    };

    it('a CREDIT_NOTE advance with NO funding release (orphan / malformed lineage)', () => {
      unresolved(
        row({ advanceSourceType: 'CREDIT_NOTE', advanceSourcePaymentId: null, fundingKind: null }),
      );
    });

    it('a payment-traced funding release WITHOUT a payment (inconsistent)', () => {
      for (const fundingKind of ['PAYMENT_ALLOCATION', 'ADVANCE_APPLICATION']) {
        unresolved(
          row({
            advanceSourceType: 'CREDIT_NOTE',
            advanceSourcePaymentId: null,
            fundingKind,
            fundingPaymentId: null,
          }),
        );
      }
    });

    it('an OPENING_ADVANCE funding release WITH a payment (inconsistent)', () => {
      unresolved(
        row({
          advanceSourceType: 'CREDIT_NOTE',
          advanceSourcePaymentId: null,
          fundingKind: 'OPENING_ADVANCE',
          fundingPaymentId: PAYMENT_P,
        }),
      );
    });

    it('an unrecognized funding sourceKind', () => {
      unresolved(
        row({
          advanceSourceType: 'CREDIT_NOTE',
          advanceSourcePaymentId: null,
          fundingKind: 'SOMETHING_ELSE',
          fundingPaymentId: PAYMENT_P,
        }),
      );
    });

    it('a PAYMENT-sourced advance with no payment (previously a silent NULL), and an unrecognized advance sourceType', () => {
      unresolved(row({ advanceSourceType: 'PAYMENT', advanceSourcePaymentId: null }));
      unresolved(row({ advanceSourceType: 'WHATEVER', advanceSourcePaymentId: null }));
    });
  });
});
