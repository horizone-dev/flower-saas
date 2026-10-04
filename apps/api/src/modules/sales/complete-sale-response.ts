import type {
  CompleteAnonymousPayNowResult,
  CompleteCustomerSaleResult,
} from './atomic-walk-in-sale.service.js';

/**
 * Task 3b.9 Checkpoint E — the PUBLIC response of `complete-sale`: stable business
 * results only, mapped from the frozen orchestrator's output.
 *
 * PURE: value in / value out. It holds no formula — every figure here was computed by
 * the frozen core (canonical totals, sale plan, receivable accounting) and is only
 * RENDERED: every Money amount as a decimal-digit STRING (a BigInt cannot be JSON
 * serialised and a JS number cannot round-trip one), mirroring
 * `payment.controller.ts` / `order.controller.ts` exactly.
 *
 * Deliberately NOT exposed: the credit-gate structures (`creditAuthorizationMode`,
 * the account lock, the exposure parameter), journal ids or lines, `operationKey`,
 * idempotency-store ids, the customer's id or account id, the `authorities` metadata,
 * any provider credential. The audit log, not the response, records an override.
 */
export interface CompleteSaleResponse {
  readonly order: { readonly id: string; readonly orderNumber: string };
  readonly invoice: {
    readonly id: string;
    readonly invoiceNumber: string;
    readonly currencyCode: string;
    readonly currencyExponent: number;
    readonly subtotalAmountMinor: string;
    readonly documentDiscountAmountMinor: string;
    readonly taxTotalAmountMinor: string;
    readonly totalAmountMinor: string;
    /** the status the frozen projection derived — `PAID`, `SETTLED`, `UNPAID` or `PARTIAL` */
    readonly paymentStatus: string;
  };
  readonly paymentIntent: 'PAY_NOW' | 'ON_CREDIT';
  /** what the sale leaves owing: 0 for PAY_NOW, > 0 for ON_CREDIT */
  readonly outstandingMinor: string;
  /** null for a single tender (or none); one shared value across a Multi Payment */
  readonly paymentGroupId: string | null;
  /** real tenders only, in request order — credit is never a Payment */
  readonly payments: readonly {
    readonly paymentId: string;
    readonly paymentAttemptId: string;
    readonly paymentAllocationId: string;
    readonly method: string;
    readonly amountMinor: string;
  }[];
  /** in ascending advance-id order; always `[]` for an anonymous sale */
  readonly advanceApplications: readonly {
    readonly applicationId: string;
    readonly advanceId: string;
    readonly amountMinor: string;
  }[];
  /** the customer receivable of an identified-customer sale; `null` for an anonymous one */
  readonly customerReceivableId: string | null;
}

export function toCompleteSaleResponse(
  result: CompleteAnonymousPayNowResult | CompleteCustomerSaleResult,
): CompleteSaleResponse {
  const customer = 'customerReceivableId' in result ? result : null;
  return {
    order: { id: result.orderId, orderNumber: result.orderNumber },
    invoice: {
      id: result.invoiceId,
      invoiceNumber: result.invoiceNumber,
      currencyCode: result.currencyCode,
      currencyExponent: result.currencyExponent,
      subtotalAmountMinor: result.subtotalAmountMinor.toString(),
      documentDiscountAmountMinor: result.documentDiscountAmountMinor.toString(),
      taxTotalAmountMinor: result.taxTotalAmountMinor.toString(),
      totalAmountMinor: result.totalAmountMinor.toString(),
      paymentStatus: result.invoicePaymentStatus,
    },
    paymentIntent: customer ? customer.paymentIntent : 'PAY_NOW',
    outstandingMinor: result.outstandingMinor.toString(),
    paymentGroupId: result.paymentGroupId,
    payments: result.payments.map((p) => ({
      paymentId: p.paymentId,
      paymentAttemptId: p.paymentAttemptId,
      paymentAllocationId: p.paymentAllocationId,
      method: p.method,
      amountMinor: p.amountMinor.toString(),
    })),
    advanceApplications: customer
      ? customer.advanceApplications.map((a) => ({
          applicationId: a.applicationId,
          advanceId: a.advanceId,
          amountMinor: a.amountMinor.toString(),
        }))
      : [],
    customerReceivableId: customer ? customer.customerReceivableId : null,
  };
}
