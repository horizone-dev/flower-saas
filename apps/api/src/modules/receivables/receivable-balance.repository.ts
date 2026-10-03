// Deliberate, owner-mandated exception (mirrors every other 3b.6 internal
// primitive in this module): a READ-ONLY helper that PARTICIPATES in the
// caller's already-open transaction — it never opens its own and never takes a
// row lock. A caller that needs a lock (FIFO receipt collection, CustomerAdvance
// application) takes the coverage-anchor lock ITSELF, in the canonical order,
// and only THEN calls this to recompute the figure under that lock.
import type { ScopedTx } from '@flower/db';
import {
  computeAdvanceBalance,
  computeReceivableBalance,
  type AdvanceBalance,
  type ReceivableBalance,
} from './receivable-balance.js';

/**
 * Task 3b.8 Integration Closure — the ONE set-based SQL that feeds the ONE
 * canonical arithmetic in `receivable-balance.ts`. The customer-account read
 * model (summary / receivables list / advances list), FIFO receipt collection,
 * CustomerAdvance application and the DIRECT invoice-payment paths (synchronous
 * capture, async reservation, webhook capture — via `loadInvoiceBalance`) ALL
 * read their figures through these functions, so "how much does this receivable
 * owe" and "how much of this advance is spendable" can never again be
 * re-derived (and mis-derived) per consumer. This module only FETCHES the raw
 * components (each aggregate is a correlated sub-select over the authoritative
 * source rows); every figure is then computed by the pure
 * `computeReceivableBalance` / `computeAdvanceBalance` — never by SQL
 * arithmetic here — so there is exactly one place the formula is written.
 *
 * NULL discipline: a receivable whose source principal cannot be resolved (no
 * invoice / no charge row) reaches `computeReceivableBalance` as `principal =
 * null` and is rejected there (`RangeError`) — never silently coerced, never an
 * "else OPENING" fallback.
 *
 * Scope is always passed in by the caller from trusted context (tenant/company
 * from the authenticated session, the account resolved server-side from the
 * route customer) — never read from a request body. RLS still applies on the
 * caller's transaction.
 */

export interface BalanceScope {
  tenantId: string;
  companyId: string;
  customerCompanyAccountId: string;
  /** `null`/`undefined` = company-wide (every branch this account has rows in). */
  branchId?: string | null;
}

export interface ReceivableBalanceRecord extends ReceivableBalance {
  customerReceivableId: string;
  branchId: string;
  createdAt: Date;
  invoiceId: string | null;
  invoiceNumber: string | null;
  cancellationChargeId: string | null;
  cancellationChargeNumber: string | null;
  /** `YYYY-MM-DD` — the source document's own civil date: invoice date /
   *  cancellation-charge accounting date / opening effective date. */
  sourceDate: string | null;
  currencyCode: string | null;
  currencyExponent: number | null;
  openingEffectiveDate: string | null;
  openingNote: string | null;
}

export interface AdvanceBalanceRecord extends AdvanceBalance {
  customerAdvanceId: string;
  sourceType: string;
  branchId: string;
  sourcePaymentId: string | null;
  currencyCode: string;
  currencyExponent: number;
  openingEffectiveDate: string | null;
  createdAt: Date;
}

/** The canonical balance of ONE invoice's receivable (see {@link loadInvoiceBalance}). */
export interface InvoiceBalanceRecord extends ReceivableBalance {
  invoiceId: string;
}

interface RawInvoiceBalanceRow {
  principal: bigint;
  paidByPayment: bigint;
  paidByAdvance: bigint;
  credited: bigint;
}

interface RawReceivableRow {
  id: string;
  sourceType: string;
  branchId: string;
  createdAt: Date;
  invoiceId: string | null;
  invoiceNumber: string | null;
  cancellationChargeId: string | null;
  cancellationChargeNumber: string | null;
  sourceDate: string | null;
  principal: bigint | null;
  paidByPayment: bigint;
  paidByAdvance: bigint;
  credited: bigint;
  currencyCode: string | null;
  currencyExponent: number | null;
  openingEffectiveDate: string | null;
  openingNote: string | null;
}

interface RawAdvanceRow {
  id: string;
  sourceType: string;
  branchId: string;
  sourcePaymentId: string | null;
  principal: bigint;
  currencyCode: string;
  currencyExponent: number;
  openingEffectiveDate: string | null;
  createdAt: Date;
  applied: bigint;
  refunded: bigint;
  reserved: bigint;
}

/**
 * Every CustomerReceivable of `scope.customerCompanyAccountId` (optionally one
 * branch, optionally ONE receivable), each with its canonical balance, ordered
 * by `id ASC` (uuidv7 — time-ordered; the list endpoint's cursor key).
 */
export async function loadReceivableBalances(
  tx: ScopedTx,
  scope: BalanceScope & { receivableId?: string | null },
): Promise<ReceivableBalanceRecord[]> {
  const branchId = scope.branchId ?? null;
  const receivableId = scope.receivableId ?? null;
  const rows = await tx.$queryRaw<RawReceivableRow[]>`
    SELECT cr."id" AS "id", cr."sourceType" AS "sourceType", cr."branchId" AS "branchId",
           cr."createdAt" AS "createdAt",
           cr."invoiceId" AS "invoiceId", i."invoiceNumber" AS "invoiceNumber",
           cr."cancellationChargeId" AS "cancellationChargeId",
           cc."cancellationChargeNumber" AS "cancellationChargeNumber",
           to_char(COALESCE(i."invoiceDate", cc."accountingDate", cr."openingEffectiveDate"), 'YYYY-MM-DD') AS "sourceDate",
           CASE cr."sourceType"
             WHEN 'INVOICE' THEN i."totalAmountMinor"
             WHEN 'OPENING' THEN cr."openingAmountMinor"
             WHEN 'CANCELLATION_CHARGE' THEN cc."totalAmountMinor"
           END AS "principal",
           CASE cr."sourceType"
             WHEN 'INVOICE' THEN COALESCE((SELECT SUM(pa."amountMinor") FROM "payment_allocation" pa WHERE pa."invoiceId" = cr."invoiceId"), 0)::bigint
             ELSE COALESCE((SELECT SUM(crpa."amountMinor") FROM "customer_receivable_payment_application" crpa WHERE crpa."customerReceivableId" = cr."id"), 0)::bigint
           END AS "paidByPayment",
           COALESCE((SELECT SUM(caa."amountMinor") FROM "customer_advance_application" caa WHERE caa."customerReceivableId" = cr."id"), 0)::bigint AS "paidByAdvance",
           CASE cr."sourceType"
             WHEN 'INVOICE' THEN COALESCE((SELECT SUM(cn."arReductionMinor") FROM "credit_note" cn WHERE cn."invoiceId" = cr."invoiceId"), 0)::bigint
             ELSE 0::bigint
           END AS "credited",
           COALESCE(i."currencyCode", cc."currencyCode", cr."currencyCode") AS "currencyCode",
           COALESCE(i."currencyExponent", cc."currencyExponent", cr."currencyExponent") AS "currencyExponent",
           to_char(cr."openingEffectiveDate", 'YYYY-MM-DD') AS "openingEffectiveDate",
           cr."openingNote" AS "openingNote"
      FROM "customer_receivable" cr
      LEFT JOIN "invoice" i ON i."id" = cr."invoiceId"
      LEFT JOIN "cancellation_charge" cc ON cc."id" = cr."cancellationChargeId"
     WHERE cr."tenantId" = ${scope.tenantId}::uuid
       AND cr."companyId" = ${scope.companyId}::uuid
       AND cr."customerCompanyAccountId" = ${scope.customerCompanyAccountId}::uuid
       AND (${branchId}::uuid IS NULL OR cr."branchId" = ${branchId}::uuid)
       AND (${receivableId}::uuid IS NULL OR cr."id" = ${receivableId}::uuid)
     ORDER BY cr."id" ASC`;

  return rows.map((r) => ({
    ...computeReceivableBalance({
      sourceType: r.sourceType,
      principalMinor: r.principal,
      paidByPaymentMinor: r.paidByPayment,
      paidByAdvanceMinor: r.paidByAdvance,
      creditedMinor: r.credited,
    }),
    customerReceivableId: r.id,
    branchId: r.branchId,
    createdAt: r.createdAt,
    invoiceId: r.invoiceId,
    invoiceNumber: r.invoiceNumber,
    cancellationChargeId: r.cancellationChargeId,
    cancellationChargeNumber: r.cancellationChargeNumber,
    sourceDate: r.sourceDate,
    currencyCode: r.currencyCode,
    currencyExponent: r.currencyExponent,
    openingEffectiveDate: r.openingEffectiveDate,
    openingNote: r.openingNote,
  }));
}

/**
 * The canonical balance of ONE invoice, keyed by the INVOICE itself — not by a
 * customer account — because the direct invoice-payment paths (synchronous
 * capture, async provider reservation, webhook capture) also serve WALK-IN
 * invoices, which have no `CustomerReceivable` at all. Same arithmetic as the
 * INVOICE branch of {@link loadReceivableBalances} (the pure
 * `computeReceivableBalance`): total − Σ PaymentAllocation − Σ CustomerAdvance-
 * Application (of the invoice's receivable, when it has one) − Σ CreditNote
 * `arReductionMinor`. Exactly the coverage the DB backstop
 * `fn_lock_and_validate_invoice_coverage` enforces.
 *
 * Read-only and lock-free: the CALLER has already locked the invoice row
 * (`FOR UPDATE`), so these sums are stable for the rest of its transaction.
 */
export async function loadInvoiceBalance(
  tx: ScopedTx,
  scope: { tenantId: string; invoiceId: string },
): Promise<InvoiceBalanceRecord> {
  const rows = await tx.$queryRaw<RawInvoiceBalanceRow[]>`
    SELECT i."totalAmountMinor" AS "principal",
           COALESCE((SELECT SUM(pa."amountMinor") FROM "payment_allocation" pa WHERE pa."invoiceId" = i."id"), 0)::bigint AS "paidByPayment",
           COALESCE((
             SELECT SUM(caa."amountMinor")
               FROM "customer_advance_application" caa
               JOIN "customer_receivable" cr ON cr."id" = caa."customerReceivableId"
              WHERE cr."invoiceId" = i."id"
           ), 0)::bigint AS "paidByAdvance",
           COALESCE((SELECT SUM(cn."arReductionMinor") FROM "credit_note" cn WHERE cn."invoiceId" = i."id"), 0)::bigint AS "credited"
      FROM "invoice" i
     WHERE i."id" = ${scope.invoiceId}::uuid
       AND i."tenantId" = ${scope.tenantId}::uuid`;
  const row = rows[0];
  if (!row) {
    throw new RangeError(
      `invoice ${scope.invoiceId} not found while computing its receivable balance`,
    );
  }
  return {
    ...computeReceivableBalance({
      sourceType: 'INVOICE',
      principalMinor: row.principal,
      paidByPaymentMinor: row.paidByPayment,
      paidByAdvanceMinor: row.paidByAdvance,
      creditedMinor: row.credited,
    }),
    invoiceId: scope.invoiceId,
  };
}

/**
 * Every CustomerAdvance of `scope.customerCompanyAccountId` (optionally one
 * branch, optionally ONE advance), each with its canonical balance — consumed
 * by applications, refund applications AND PENDING provider-refund
 * reservations, exactly what the DB `fn_lock_and_validate_advance_capacity`
 * backstop enforces — ordered by `id ASC`.
 */
export async function loadAdvanceBalances(
  tx: ScopedTx,
  scope: BalanceScope & { advanceId?: string | null },
): Promise<AdvanceBalanceRecord[]> {
  const branchId = scope.branchId ?? null;
  const advanceId = scope.advanceId ?? null;
  const rows = await tx.$queryRaw<RawAdvanceRow[]>`
    SELECT ca."id" AS "id", ca."sourceType" AS "sourceType", ca."branchId" AS "branchId",
           ca."sourcePaymentId" AS "sourcePaymentId", ca."amountMinor" AS "principal",
           ca."currencyCode" AS "currencyCode", ca."currencyExponent" AS "currencyExponent",
           to_char(ca."openingEffectiveDate", 'YYYY-MM-DD') AS "openingEffectiveDate",
           ca."createdAt" AS "createdAt",
           COALESCE((SELECT SUM(caa."amountMinor") FROM "customer_advance_application" caa WHERE caa."customerAdvanceId" = ca."id"), 0)::bigint AS "applied",
           COALESCE((SELECT SUM(rfa."amountMinor") FROM "customer_advance_refund_application" rfa WHERE rfa."customerAdvanceId" = ca."id"), 0)::bigint AS "refunded",
           COALESCE((
             SELECT SUM(rr."amountMinor")
               FROM "refund_attempt_entitlement_reservation" rr
               JOIN "refund_attempt" ra ON ra."id" = rr."refundAttemptId"
              WHERE rr."customerAdvanceId" = ca."id" AND ra."state" = 'PENDING'
           ), 0)::bigint AS "reserved"
      FROM "customer_advance" ca
     WHERE ca."tenantId" = ${scope.tenantId}::uuid
       AND ca."companyId" = ${scope.companyId}::uuid
       AND ca."customerCompanyAccountId" = ${scope.customerCompanyAccountId}::uuid
       AND (${branchId}::uuid IS NULL OR ca."branchId" = ${branchId}::uuid)
       AND (${advanceId}::uuid IS NULL OR ca."id" = ${advanceId}::uuid)
     ORDER BY ca."id" ASC`;

  return rows.map((r) => ({
    ...computeAdvanceBalance({
      principalMinor: r.principal,
      appliedMinor: r.applied,
      refundedMinor: r.refunded,
      reservedMinor: r.reserved,
    }),
    customerAdvanceId: r.id,
    sourceType: r.sourceType,
    branchId: r.branchId,
    sourcePaymentId: r.sourcePaymentId,
    currencyCode: r.currencyCode,
    currencyExponent: r.currencyExponent,
    openingEffectiveDate: r.openingEffectiveDate,
    createdAt: r.createdAt,
  }));
}
