/**
 * Task 3b.6 Checkpoint A — pure credit-exposure/available-credit arithmetic.
 * NO DB, NO HTTP, NO permission/override handling.
 *
 * Error convention: this module throws plain `RangeError`, matching the
 * repository's established pure-module convention (`available-to-collect.ts`,
 * `payment-attempt-state.ts`, `synchronous-multi-payment.ts` — none of which
 * import `DomainError`/an HTTP status into a DB/HTTP-free module). The
 * future service layer is expected to surface a rejection here as
 * `CUSTOMER_CREDIT_DISABLED` (422) or `CUSTOMER_CREDIT_LIMIT_EXCEEDED` (409)
 * — documented as the intended codes, not constructed here.
 *
 * Frozen formulas (3b.6 architecture-freeze passes, this session):
 *   receivableOutstanding — the caller's own sum of every open
 *     `CustomerReceivable`'s outstanding amount (this module performs no DB
 *     sum itself, exactly like `computeAvailableToCollect`'s own contract).
 *   creditExposure = receivableOutstanding — an *unapplied* Advance does
 *     NOT reduce it (frozen explicitly, retracting an earlier draft's
 *     "natural reading" — only an actual `CustomerAdvanceApplication`
 *     reduces the specific receivable it targets, which is already reflected
 *     in `receivableOutstanding` itself).
 *   availableCredit:
 *     - `creditEnabled = false` → credit sale is never allowed, regardless
 *       of `creditLimitMinor`/exposure (a disabled account has no available
 *       credit concept at all — this module reports it as its own outcome,
 *       see `evaluateCreditAuthorization`, rather than a numeric value).
 *     - `creditEnabled = true`, `creditLimitMinor = null` → no numeric
 *       ceiling (3b.2's own frozen "nullable = no numeric ceiling beyond
 *       `credit_enabled`").
 *     - `creditEnabled = true`, `creditLimitMinor` present →
 *       `max(creditLimitMinor - creditExposure, 0)`.
 *   A proposed `ON_CREDIT` sale of `proposedOutstandingAmountMinor` is
 *   rejected iff `creditLimitMinor` is non-null AND
 *   `creditExposure + proposedOutstandingAmountMinor > creditLimitMinor`.
 *   `PAY_NOW` never runs this gate at all (see `payment-intent.ts`) — but
 *   a later genuine shortfall on a `PAY_NOW` invoice becomes real
 *   `receivableOutstanding` like any other receivable, and is therefore
 *   counted by this module the next time it is called, with no special
 *   exemption for having originated as an unintended shortfall.
 */

export interface CreditAccountState {
  readonly creditEnabled: boolean;
  /** null = no numeric ceiling (3b.2 §1's own frozen meaning) */
  readonly creditLimitMinor: bigint | null;
  /** the caller's own authoritative sum of every open CustomerReceivable's
   *  outstanding amount for this account — never computed here. */
  readonly receivableOutstandingMinor: bigint;
}

function assertNonNegative(value: bigint, label: string): void {
  if (value < 0n) {
    throw new RangeError(`${label} must be >= 0 (got ${value})`);
  }
}

/** Pure exposure formula — an unapplied Advance never reduces this. */
export function computeCreditExposure(state: CreditAccountState): bigint {
  assertNonNegative(state.receivableOutstandingMinor, 'receivableOutstandingMinor');
  return state.receivableOutstandingMinor;
}

/**
 * `null` return means "no numeric ceiling" (either `creditEnabled = false`
 * — available credit is not a meaningful concept for a disabled account, so
 * this deliberately does not report `0`, which would misleadingly suggest a
 * ceiling of zero rather than "credit is off" — or `creditLimitMinor` is
 * itself `null`).
 */
export function computeAvailableCredit(state: CreditAccountState): bigint | null {
  if (!state.creditEnabled) return null;
  if (state.creditLimitMinor === null) return null;
  assertNonNegative(state.creditLimitMinor, 'creditLimitMinor');
  const exposure = computeCreditExposure(state);
  const available = state.creditLimitMinor - exposure;
  return available > 0n ? available : 0n;
}

export type CreditAuthorizationResult =
  | { readonly outcome: 'ALLOWED' }
  | { readonly outcome: 'DISABLED' }
  | {
      readonly outcome: 'LIMIT_EXCEEDED';
      readonly creditLimitMinor: bigint;
      readonly projectedExposureMinor: bigint;
    };

/**
 * The pure arithmetic/policy result an `ON_CREDIT` sale decision is built
 * from. Deliberately does NOT implement owner override — a later,
 * integration-layer caller may deliberately proceed past a `LIMIT_EXCEEDED`
 * result once permission/step-up/reason/audit (owner-only
 * `customers:credit:override`, frozen in 3b.2) have been independently
 * satisfied; this function only ever answers the un-overridden policy
 * question.
 */
export function evaluateCreditAuthorization(
  state: CreditAccountState,
  proposedOutstandingAmountMinor: bigint,
): CreditAuthorizationResult {
  assertNonNegative(proposedOutstandingAmountMinor, 'proposedOutstandingAmountMinor');
  if (!state.creditEnabled) {
    return { outcome: 'DISABLED' };
  }
  if (state.creditLimitMinor === null) {
    return { outcome: 'ALLOWED' };
  }
  assertNonNegative(state.creditLimitMinor, 'creditLimitMinor');
  const exposure = computeCreditExposure(state);
  const projectedExposureMinor = exposure + proposedOutstandingAmountMinor;
  if (projectedExposureMinor > state.creditLimitMinor) {
    return {
      outcome: 'LIMIT_EXCEEDED',
      creditLimitMinor: state.creditLimitMinor,
      projectedExposureMinor,
    };
  }
  return { outcome: 'ALLOWED' };
}
