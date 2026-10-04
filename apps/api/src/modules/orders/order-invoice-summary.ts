/**
 * Task 3b.9 Checkpoint A (A5) — the recovery-read design pin (owner ruling
 * OD-13).
 *
 * A completed sale must be recoverable after a LOST HTTP response: a client that
 * only has the `orderId` must be able to learn the issued invoice's id, number,
 * date, total and payment status. The additive, read-only
 * `issuedInvoice` summary on the existing Order GET carries exactly that — and
 * nothing else:
 *
 *   - authority: the existing `orders:view` (no new permission);
 *   - source:   the ISSUED `invoice` row only (`invoice.orderId` is UNIQUE), so
 *               there is no second financial source of truth — the summary is a
 *               projection of the immutable document, never recomputed from the
 *               mutable order, never cached;
 *   - shape:    five fields. The currency is not repeated — the order row the
 *               client already holds carries it (an invoice is always issued in
 *               its order's currency, DB-enforced);
 *   - absence:  `null` while the order has no invoice (DRAFT / HELD / a
 *               cancelled-before-invoice order).
 *
 * Checkpoint E wired this into the Order GET as `issuedInvoice`
 * (`OrderRepository.getWithIssuedInvoiceForBranchScoped`: one scoped read of the
 * ISSUED invoice — `SELECT … FROM invoice WHERE orderId = $1 AND tenantId /
 * companyId / branchId = trusted scope` — in the same transaction as the order
 * read) and into the Order GET controller. This file is only the pure projection
 * + the pinned contract; it does not touch the order read path.
 */

/** the columns of the ISSUED `invoice` row this summary reads — nothing more */
export interface IssuedInvoiceSummarySource {
  readonly id: string;
  readonly invoiceNumber: string;
  /** a `DATE` column — Prisma returns midnight UTC of the stored civil date;
   *  a raw `::text` read returns the `YYYY-MM-DD` string directly. */
  readonly invoiceDate: Date | string;
  readonly totalAmountMinor: bigint;
  /** derived (never hand-written) — read as stored. */
  readonly invoicePaymentStatus: string;
}

export interface OrderInvoiceSummary {
  readonly invoiceId: string;
  readonly invoiceNumber: string;
  /** the invoice's civil accounting date, `YYYY-MM-DD` */
  readonly invoiceDate: string;
  /** exact minor units as a decimal-digit STRING (never a JS number) */
  readonly totalAmountMinor: string;
  readonly invoicePaymentStatus: string;
}

const FISCAL_DATE = /^\d{4}-\d{2}-\d{2}$/;

function civilDate(value: Date | string): string {
  if (typeof value === 'string') {
    if (!FISCAL_DATE.test(value)) {
      throw new RangeError(`invoiceDate must be YYYY-MM-DD (got ${value})`);
    }
    return value;
  }
  if (Number.isNaN(value.getTime())) throw new RangeError('invoiceDate is an invalid Date');
  // A `DATE` column is stored as a civil date and surfaces as midnight UTC. Any
  // other time-of-day means the value did NOT come from a DATE column — reading
  // its UTC date could silently shift the civil day, so fail instead.
  if (
    value.getUTCHours() !== 0 ||
    value.getUTCMinutes() !== 0 ||
    value.getUTCSeconds() !== 0 ||
    value.getUTCMilliseconds() !== 0
  ) {
    throw new RangeError('invoiceDate must be a DATE value (midnight UTC), not an instant');
  }
  return value.toISOString().slice(0, 10);
}

/** `null` in → `null` out (no invoice issued yet); otherwise the five-field projection. */
export function toOrderInvoiceSummary(
  invoice: IssuedInvoiceSummarySource | null | undefined,
): OrderInvoiceSummary | null {
  if (invoice === null || invoice === undefined) return null;
  if (typeof invoice.totalAmountMinor !== 'bigint') {
    throw new RangeError('totalAmountMinor must be an exact BigInt');
  }
  return {
    invoiceId: invoice.id,
    invoiceNumber: invoice.invoiceNumber,
    invoiceDate: civilDate(invoice.invoiceDate),
    totalAmountMinor: invoice.totalAmountMinor.toString(),
    invoicePaymentStatus: invoice.invoicePaymentStatus,
  };
}
