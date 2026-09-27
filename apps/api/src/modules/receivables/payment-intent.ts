/**
 * Task 3b.6 Checkpoint A — pure `PAY_NOW`/`ON_CREDIT` intent model. NO DB,
 * NO permission/override handling (that is a later integration checkpoint's
 * concern — this module only ever computes the resulting `creditAuthorized`
 * flag and whether the credit gate must run, never who is allowed to
 * proceed past a blocked result).
 *
 * Frozen rules (3b.6 architecture-freeze, this session):
 *   - Exactly two values — `PAY_NOW` | `ON_CREDIT`. No third value, no
 *     `CREDIT` tender (CREDIT remains forbidden as a `TenderMethod`,
 *     unchanged from 3b.5/ADR-0019 §1 — this enum is a distinct concept:
 *     an issuance-time INTENT, never a tender).
 *   - Both intents create customer AR when the Invoice is customer-linked
 *     — `paymentIntent` never gates AR creation itself (3b.6
 *     architecture-freeze correction), only whether the credit-limit gate
 *     runs at issuance.
 *   - `PAY_NOW` → the credit gate does not run at issuance;
 *     `creditAuthorized = false` unconditionally for the resulting
 *     `CustomerReceivable`.
 *   - `ON_CREDIT` → the credit gate MUST run (via
 *     `credit-exposure.ts#evaluateCreditAuthorization`); `creditAuthorized`
 *     becomes `true` only once that evaluation (or a later, deliberate,
 *     permission-gated override — never decided in this module) actually
 *     allows the sale.
 */

export type PaymentIntent = 'PAY_NOW' | 'ON_CREDIT';

export const PAYMENT_INTENTS: readonly PaymentIntent[] = Object.freeze(['PAY_NOW', 'ON_CREDIT']);

/** Whether the credit-limit gate must run at issuance for this intent. */
export function requiresCreditGate(intent: PaymentIntent): boolean {
  switch (intent) {
    case 'PAY_NOW':
      return false;
    case 'ON_CREDIT':
      return true;
    default: {
      const exhaustive: never = intent;
      throw new RangeError(`requiresCreditGate: unrecognized PaymentIntent ${String(exhaustive)}`);
    }
  }
}

/**
 * The `creditAuthorized` value a resulting `CustomerReceivable(INVOICE)`
 * must carry. `creditGateAllowed` is only consulted for `ON_CREDIT` — for
 * `PAY_NOW` it is ignored entirely (unconditionally `false`), since the
 * gate never ran and nothing was ever authorized.
 */
export function computeCreditAuthorizedFlag(
  intent: PaymentIntent,
  creditGateAllowed: boolean,
): boolean {
  switch (intent) {
    case 'PAY_NOW':
      return false;
    case 'ON_CREDIT':
      return creditGateAllowed;
    default: {
      const exhaustive: never = intent;
      throw new RangeError(
        `computeCreditAuthorizedFlag: unrecognized PaymentIntent ${String(exhaustive)}`,
      );
    }
  }
}

/** Both intents create AR for a customer-linked Invoice — this is a
 *  documentation-level constant, not a branch, precisely because there is
 *  no conditional behavior here (the 3b.6 architecture-freeze correction:
 *  `paymentIntent` never gates AR creation, only the credit gate). */
export const ALWAYS_CREATES_CUSTOMER_AR_WHEN_LINKED = true as const;
