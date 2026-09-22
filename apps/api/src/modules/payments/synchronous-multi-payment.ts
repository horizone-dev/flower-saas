import { isProviderBackedTender, type TenderMethod } from './tender.js';

/**
 * Task 3b.5 Checkpoint A — pure validation for the frozen synchronous Multi
 * Payment contract (owner contract round 3, §1/§2). NO DB, NO external side
 * effects.
 *
 * Atomic synchronous Multi Payment is supported ONLY for tenders whose
 * financial confirmation already exists locally/operator-confirmed and
 * requires no external irreversible call during the transaction. This
 * function enforces that boundary — it never claims atomicity across an
 * external payment network, and it rejects any provider-backed component
 * outright (see `isProviderBackedTender`).
 *
 * Error convention: this module throws plain `RangeError`, matching the
 * repository's established pure-module convention (`tax-arithmetic.ts`,
 * `document-discount-allocation.ts` — no `DomainError`/HTTP status in a
 * DB/HTTP-free module). The future service layer is expected to surface a
 * failure here as one of `PAYMENT_INVALID_AMOUNT` (422),
 * `PAYMENT_CURRENCY_MISMATCH` (422), or
 * `PAYMENT_ASYNC_TENDER_NOT_ALLOWED_IN_ATOMIC_MULTI_PAYMENT` (422), and an
 * `availableToCollectMinor` violation as `INVOICE_INSUFFICIENT_AVAILABLE_BALANCE`
 * (409) — documented as the intended codes, not constructed here.
 */
export interface SynchronousTenderComponent {
  readonly method: TenderMethod;
  /** non-null only for a provider-backed CARD_TERMINAL — see tender.ts */
  readonly providerCredentialId: string | null;
  readonly amountMinor: bigint;
  readonly currencyCode: string;
  readonly currencyExponent: number;
}

export interface ValidateSynchronousMultiPaymentInput {
  readonly intendedPaymentAmountMinor: bigint;
  readonly invoiceCurrencyCode: string;
  readonly invoiceCurrencyExponent: number;
  readonly components: readonly SynchronousTenderComponent[];
  /**
   * The authoritative `availableToCollect` value (from
   * `computeAvailableToCollect`, computed by the caller under the Invoice
   * lock). Optional here because this is a pure validator and the caller may
   * not yet have that value when merely shaping/pre-checking a request; when
   * provided, it is enforced.
   */
  readonly availableToCollectMinor?: bigint;
}

export function validateSynchronousMultiPayment(input: ValidateSynchronousMultiPaymentInput): void {
  if (input.components.length === 0) {
    throw new RangeError('a synchronous Multi Payment requires at least one tender component');
  }

  let sum = 0n;
  for (const [index, component] of input.components.entries()) {
    if (component.amountMinor <= 0n) {
      throw new RangeError(
        `component[${index}] amountMinor must be > 0 (got ${component.amountMinor})`,
      );
    }
    if (
      component.currencyCode !== input.invoiceCurrencyCode ||
      component.currencyExponent !== input.invoiceCurrencyExponent
    ) {
      throw new RangeError(
        `component[${index}] currency ${component.currencyCode}/${component.currencyExponent} ` +
          `does not match the invoice's ${input.invoiceCurrencyCode}/${input.invoiceCurrencyExponent}`,
      );
    }
    if (isProviderBackedTender(component.method, component.providerCredentialId)) {
      throw new RangeError(
        `component[${index}] (${component.method}${
          component.providerCredentialId ? ', provider-backed' : ''
        }) requires the async PaymentAttempt/provider flow and cannot participate in a synchronous ` +
          'atomic Multi Payment transaction',
      );
    }
    sum += component.amountMinor;
  }

  if (sum !== input.intendedPaymentAmountMinor) {
    throw new RangeError(
      `component amounts sum to ${sum}, which does not equal the intended payment amount ` +
        `${input.intendedPaymentAmountMinor}`,
    );
  }

  if (
    input.availableToCollectMinor !== undefined &&
    input.intendedPaymentAmountMinor > input.availableToCollectMinor
  ) {
    throw new RangeError(
      `intended payment amount ${input.intendedPaymentAmountMinor} exceeds the currently available ` +
        `${input.availableToCollectMinor}`,
    );
  }
}
