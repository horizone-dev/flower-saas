// Deliberate, owner-mandated exception (mirrors `PaymentCollectionRepository` and
// `receivable-balance.repository.ts` exactly): an internal primitive that PARTICIPATES in the
// caller's already-open transaction — it never opens its own. (The `.repository.ts` suffix is
// what the `no-raw-prisma-in-scoped-modules` lint rule keys on; this file holds plain functions.)
import type { ScopedTx } from '@flower/db';
import { DomainError, NotFoundError } from '../../common/errors/domain-error.js';

/**
 * Task 3b.8 Integration Closure (F4) — acquires, in the CANONICAL lock hierarchy, the two rows an
 * invoice-keyed payment write needs: the Order the invoice was issued from, then the Invoice.
 *
 * ── THE LOCK GRAPH (inventoried path by path; this is the actual state, not an intention) ──────
 *
 *   ORDER  →  INVOICE  →  receivable / customer-account / payment / allocation / advance rows
 *          →  settlement & projection rows
 *
 *   post-invoice cancellation   order(UPDATE) → invoice(UPDATE) → account(UPDATE) → order_line(UPDATE)
 *                               → release sources (allocation / application rows, the new advance)
 *                               → numbering counter → GL (company / period SHARE)
 *   direct payment (sync)       order(SHARE) → invoice(UPDATE) → payment_attempt/payment/allocation
 *   async reservation           order(SHARE) → invoice(UPDATE) → payment_attempt           (THIS helper)
 *   webhook capture / provider-initiation result / recovery
 *                               invoice(UPDATE) → payment_attempt(UPDATE) → inbox row (SKIP LOCKED) → …
 *                               They only READ the order (a plain SELECT, no lock) and insert no row
 *                               that references it, so they hold nothing the cancellation's ORDER
 *                               lock can conflict with: they can never close a cycle with it.
 *   customer receipt (FIFO), advance application
 *                               invoice | receivable(UPDATE) → account(UPDATE) → payment | advance
 *                               (no ORDER lock; invoice-before-account, exactly like the cancellation)
 *   settlement finalization     batch → invoices (ascending) → payments (ascending) → advances (ascending)
 *   invoice issuance            order(UPDATE) → account(UPDATE) → NEW invoice row (unlockable by others)
 *
 * The ONE cycle that existed was `cancellation: ORDER → INVOICE` against `payment: INVOICE → (order)`.
 * The payment never locked the order on purpose — but the `payment_attempt` row it INSERTs carries a
 * foreign key to the order, and PostgreSQL takes an implicit FOR KEY SHARE on the referenced order
 * row, which conflicts with the cancellation's FOR UPDATE. Two independent transactions in opposite
 * order is a deadlock (40P01 → surfaced as a 500). The fix is the hierarchy, not an error translation.
 *
 * ── WHY THIS IS SAFE ───────────────────────────────────────────────────────────────────────────
 * `invoice.orderId` is immutable (an issued Invoice is never re-pointed), so it is the ONE thing
 * read BEFORE any lock — a non-locking peek used only to learn WHICH order to lock first. Every
 * business decision after this call is made from the rows re-read UNDER lock; the locked invoice's
 * `orderId` is re-verified against the peek (it can never differ — a mismatch would mean an
 * impossible re-pointing, and fails closed rather than proceeding on the wrong order).
 *
 * The order is locked FOR SHARE: a payment is a READER of the order (it binds to its commercial
 * fingerprint/version), and SHARE keeps that row stable for the whole payment transaction while
 * conflicting with the cancellation's (and every other writer's) FOR UPDATE. Two payments for the
 * same order both take SHARE (compatible) and serialize on the INVOICE lock, exactly as before.
 *
 * The caller's trusted tenant/company/branch scope is part of every predicate, so a wrong-scope
 * invoice is the same non-disclosing `INVOICE_NOT_FOUND` it always was.
 */
export interface PaymentTargetScope {
  tenantId: string;
  companyId: string;
  branchId: string;
  invoiceId: string;
}

export interface LockedPaymentTarget {
  invoice: { id: string; orderId: string; currencyCode: string; currencyExponent: number };
  order: { id: string; commercialSnapshotFingerprint: string; version: number };
}

export async function lockOrderThenInvoiceInTx(
  tx: ScopedTx,
  scope: PaymentTargetScope,
): Promise<LockedPaymentTarget> {
  // 0. NON-locking peek — the immutable `orderId` only.
  const peekRows = await tx.$queryRaw<{ orderId: string }[]>`
    SELECT "orderId"
      FROM "invoice"
     WHERE "id" = ${scope.invoiceId}::uuid
       AND "tenantId" = ${scope.tenantId}::uuid
       AND "companyId" = ${scope.companyId}::uuid
       AND "branchId" = ${scope.branchId}::uuid`;
  const peekedOrderId = peekRows[0]?.orderId;
  if (!peekedOrderId) throw new NotFoundError('invoice', 'INVOICE_NOT_FOUND');

  // 1. ORDER first — FOR SHARE (see above). Read under the lock.
  const orderRows = await tx.$queryRaw<
    { id: string; commercialSnapshotFingerprint: string; version: number }[]
  >`
    SELECT "id", "commercialSnapshotFingerprint", "version"
      FROM "order"
     WHERE "id" = ${peekedOrderId}::uuid
       AND "tenantId" = ${scope.tenantId}::uuid
       FOR SHARE`;
  const order = orderRows[0];
  if (!order) throw new NotFoundError('order', 'ORDER_NOT_FOUND');

  // 2. INVOICE second — FOR UPDATE, in the EXACT trusted tenant/company/branch scope (a wrong
  //    company/branch never matches this WHERE clause, regardless of DB RLS, which is tenant-only).
  const invoiceRows = await tx.$queryRaw<
    { id: string; orderId: string; currencyCode: string; currencyExponent: number }[]
  >`
    SELECT "id", "orderId", "currencyCode", "currencyExponent"
      FROM "invoice"
     WHERE "id" = ${scope.invoiceId}::uuid
       AND "tenantId" = ${scope.tenantId}::uuid
       AND "companyId" = ${scope.companyId}::uuid
       AND "branchId" = ${scope.branchId}::uuid
       FOR UPDATE`;
  const invoice = invoiceRows[0];
  if (!invoice) throw new NotFoundError('invoice', 'INVOICE_NOT_FOUND');

  // 3. revalidate under lock — the pre-lock peek is never trusted for the decision itself.
  if (invoice.orderId !== order.id) {
    throw new DomainError(
      'PAYMENT_TARGET_ORDER_MISMATCH',
      'the invoice no longer belongs to the order that was locked for this payment',
      409,
    );
  }

  return { invoice, order };
}
