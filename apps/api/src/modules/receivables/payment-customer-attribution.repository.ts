import { Injectable } from '@nestjs/common';
// Deliberate, owner-mandated exception (mirrors every other 3b.5/3b.6
// internal primitive): PARTICIPATES in the caller's already-open
// transaction, never opens its own.
import type { ScopedTx } from '@flower/db';

export interface ResolvePaymentAttributionInput {
  tenantId: string;
  companyId: string;
  paymentId: string;
}

export interface PaymentAttributionResult {
  /** NULL for a walk-in-Invoice-collection Payment — never customer-account
   *  effects, never 3b.6 GL, for that Payment. */
  customerCompanyAccountId: string | null;
  receiptPurpose: 'INVOICE_COLLECTION' | 'CUSTOMER_RECEIPT';
  /** the Invoice this Payment's PaymentAllocation(s) target — NULL for a
   *  CUSTOMER_RECEIPT Payment (no Invoice at all). */
  targetInvoiceId: string | null;
}

/**
 * Task 3b.6 Checkpoint D (D4) — the ONE trusted internal resolver for
 * "who is this canonical Payment attributable to." Never accepts a
 * caller-supplied customer/account id to reinterpret an existing Payment —
 * always re-derives from the Payment's own immutable `sourceAttemptId`.
 *
 * `CUSTOMER_RECEIPT`: the attributed account is the PaymentAttempt's own
 * frozen `customerCompanyAccountId` (trusted at attempt-creation time,
 * 3b.6 Checkpoint B's structural XOR — never NULL for this purpose).
 *
 * `INVOICE_COLLECTION`: resolved through `targetInvoiceId` -> the Invoice's
 * `Order.customerId` -> the matching `CustomerCompanyAccount` for THIS
 * company. A walk-in Invoice (`Order.customerId IS NULL`) resolves to NULL —
 * zero customer-account effects, zero 3b.6 GL, by construction (mirrors the
 * `fn_check_customer_receivable_integrity` trigger's own walk-in exclusion).
 *
 * Used uniformly (owner contract D4) by: CustomerAccountEntry(PAYMENT)
 * creation, receipt GL, allocation/account-projection logic, and
 * opening-receivable application validation — one resolver, one meaning,
 * everywhere.
 */
@Injectable()
export class PaymentCustomerAttributionRepository {
  async resolveInTx(
    tx: ScopedTx,
    input: ResolvePaymentAttributionInput,
  ): Promise<PaymentAttributionResult> {
    const rows = await tx.$queryRaw<
      {
        receiptPurpose: string;
        attemptCustomerCompanyAccountId: string | null;
        targetInvoiceId: string | null;
        orderCustomerId: string | null;
      }[]
    >`
      SELECT
        pa."receiptPurpose"               AS "receiptPurpose",
        pa."customerCompanyAccountId"     AS "attemptCustomerCompanyAccountId",
        pa."targetInvoiceId"              AS "targetInvoiceId",
        o."customerId"                    AS "orderCustomerId"
        FROM "payment" p
        INNER JOIN "payment_attempt" pa ON pa."id" = p."sourceAttemptId"
        LEFT JOIN "invoice" i ON i."id" = pa."targetInvoiceId"
        LEFT JOIN "order" o ON o."id" = i."orderId"
       WHERE p."id" = ${input.paymentId}::uuid
         AND p."tenantId" = ${input.tenantId}::uuid
         AND p."companyId" = ${input.companyId}::uuid`;
    const row = rows[0];
    if (!row) {
      throw new RangeError(
        `PaymentCustomerAttributionRepository: payment ${input.paymentId} not found in scope`,
      );
    }

    if (row.receiptPurpose === 'CUSTOMER_RECEIPT') {
      return {
        customerCompanyAccountId: row.attemptCustomerCompanyAccountId,
        receiptPurpose: 'CUSTOMER_RECEIPT',
        targetInvoiceId: null,
      };
    }

    if (!row.orderCustomerId) {
      // walk-in — zero customer-account effects, by construction.
      return {
        customerCompanyAccountId: null,
        receiptPurpose: 'INVOICE_COLLECTION',
        targetInvoiceId: row.targetInvoiceId,
      };
    }

    const accountRows = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "customer_company_account"
       WHERE "tenantId" = ${input.tenantId}::uuid
         AND "companyId" = ${input.companyId}::uuid
         AND "customerId" = ${row.orderCustomerId}::uuid`;

    return {
      customerCompanyAccountId: accountRows[0]?.id ?? null,
      receiptPurpose: 'INVOICE_COLLECTION',
      targetInvoiceId: row.targetInvoiceId,
    };
  }
}
