import { currencyExponent, isKnownCurrency } from '@flower/money';
import { isProviderBackedTender, isTenderMethod, type TenderMethod } from '../payments/tender.js';
import { resolveReceiptAccountKeyForTender } from '../payments/tender-account-mapping.js';

/**
 * Task 3b.9 Checkpoint A (A3) — the PURE anonymous walk-in sale journal plan.
 *
 * An anonymous WALK_IN sale (`customerId = null`) runs NONE of the 3b.6
 * customer-account machinery: issuance posts no journal, tender capture posts
 * no journal (both are gated on a customer receivable). So the whole sale is
 * booked by ONE balanced journal entry, planned here and posted — in the same
 * transaction — by Checkpoint B:
 *
 *     Dr  <tender account>        per tender, same-account tenders aggregated
 *     Cr  REVENUE.SALES           total − tax        (net-of-discount convention)
 *     Cr  LIABILITY.TAX_PAYABLE   tax
 *
 *   sourceKind = 'walk_in_sale'   sourceId = the issued invoice id
 *
 * (One entry per sale — CLAUDE.md rule 16: "Order + payment = one entry, not
 * three revenues"; the posting engine's `(tenant, company, sourceKind, sourceId)`
 * uniqueness makes a re-post a no-op.)
 *
 * REVENUE CONVENTION — frozen, owner ruling OD-3 (docs/decisions/DECISION-LOG.md
 * `3b.9-ACC`): Phase 3B books revenue NET of line and document discounts, the
 * SAME convention already shipped in `invoice_ar` (3b.6) and mirrored by the
 * credit-note journal (3b.8). `REVENUE.SALES` is therefore `total − tax`
 * (equivalently subtotal − discounts, in TAX_EXCLUSIVE, and the tax-extracted
 * net in TAX_INCLUSIVE). No gross + contra-revenue split is made here — an
 * anonymous sale must not use a different model from a customer sale.
 *
 * The tender -> account mapping is the frozen 3b.6 one
 * (`resolveReceiptAccountKeyForTender`): CASH -> ASSET.CASH_ON_HAND,
 * BANK_TRANSFER -> ASSET.BANK, manual CARD_TERMINAL / OTHER_MANUAL ->
 * ASSET.PAYMENT_CLEARING. A provider-backed or unknown tender FAILS CLOSED —
 * it can never reach an atomic sale, so it can never be booked by this journal.
 *
 * PURE: no DB, no posting engine, no clock, no side effect. Exact BigInt only.
 * Line order is deterministic (see {@link DEBIT_ACCOUNT_ORDER}); a zero-valued
 * leg is omitted (the sealed-journal `journal_line_exactly_one_side` CHECK
 * rejects a zero line).
 */

export const WALK_IN_SALE_SOURCE_KIND = 'walk_in_sale' as const;

export const REVENUE_ACCOUNT_KEY = 'REVENUE.SALES' as const;
export const TAX_PAYABLE_ACCOUNT_KEY = 'LIABILITY.TAX_PAYABLE' as const;

/** the fixed order debit lines are emitted in, whatever order tenders arrive in */
export const DEBIT_ACCOUNT_ORDER: readonly string[] = Object.freeze([
  'ASSET.CASH_ON_HAND',
  'ASSET.BANK',
  'ASSET.PAYMENT_CLEARING',
]);

export interface WalkInJournalLine {
  readonly accountKey: string;
  readonly direction: 'debit' | 'credit';
  readonly amountMinor: bigint;
}

export interface WalkInJournalTender {
  /** a plain string so an unknown / forbidden value can be represented and
   *  rejected — a planned tender (`PlannedTender`) always satisfies this. */
  readonly method: string;
  readonly amountMinor: bigint;
  /** INTERNAL trust-boundary field, as everywhere else: a CARD_TERMINAL with a
   *  credential is provider-backed and is rejected. */
  readonly providerCredentialId?: string | null;
}

export interface BuildWalkInSaleJournalInput {
  readonly invoiceId: string;
  /** must be `null` — a customer-linked sale is booked by the frozen 3b.6
   *  journals and must never be double-booked here. */
  readonly customerId: string | null;
  readonly currencyCode: string;
  readonly currencyExponent: number;
  readonly totalAmountMinor: bigint;
  readonly taxTotalAmountMinor: bigint;
  readonly tenders: readonly WalkInJournalTender[];
}

export interface WalkInSaleJournalPlan {
  readonly sourceKind: typeof WALK_IN_SALE_SOURCE_KIND;
  readonly sourceId: string;
  readonly lines: readonly WalkInJournalLine[];
  readonly totalDebitMinor: bigint;
  readonly totalCreditMinor: bigint;
}

export function buildWalkInSaleJournal(input: BuildWalkInSaleJournalInput): WalkInSaleJournalPlan {
  if (typeof input.invoiceId !== 'string' || input.invoiceId.trim() === '') {
    throw new RangeError('buildWalkInSaleJournal: invoiceId (the journal sourceId) is required');
  }
  if (input.customerId !== null) {
    throw new RangeError(
      'buildWalkInSaleJournal: this journal books an ANONYMOUS sale only — a customer-linked sale uses the frozen 3b.6 journals',
    );
  }
  if (
    typeof input.currencyCode !== 'string' ||
    !isKnownCurrency(input.currencyCode) ||
    currencyExponent(input.currencyCode) !== input.currencyExponent
  ) {
    throw new RangeError(
      `buildWalkInSaleJournal: ${String(input.currencyCode)}/${String(input.currencyExponent)} is not a known currency / exponent pair`,
    );
  }
  if (typeof input.totalAmountMinor !== 'bigint' || input.totalAmountMinor <= 0n) {
    throw new RangeError('buildWalkInSaleJournal: totalAmountMinor must be a BigInt > 0');
  }
  if (typeof input.taxTotalAmountMinor !== 'bigint' || input.taxTotalAmountMinor < 0n) {
    throw new RangeError('buildWalkInSaleJournal: taxTotalAmountMinor must be a BigInt >= 0');
  }
  if (input.taxTotalAmountMinor > input.totalAmountMinor) {
    throw new RangeError('buildWalkInSaleJournal: tax cannot exceed the sale total');
  }
  if (input.tenders.length === 0) {
    throw new RangeError(
      'buildWalkInSaleJournal: an anonymous sale is paid in full — at least one tender is required',
    );
  }

  // ── debit side: aggregate tenders per frozen account ─────────────────────
  const debitByAccount = new Map<string, bigint>();
  for (const [i, t] of input.tenders.entries()) {
    if (typeof t.method !== 'string' || !isTenderMethod(t.method)) {
      throw new RangeError(
        `buildWalkInSaleJournal: tenders[${i}].method ${String(t.method)} is not a tender`,
      );
    }
    const method = t.method as TenderMethod;
    if (isProviderBackedTender(method, t.providerCredentialId ?? null)) {
      throw new RangeError(
        `buildWalkInSaleJournal: tenders[${i}] (${method}) is provider-backed and can never be booked by an atomic sale`,
      );
    }
    if (typeof t.amountMinor !== 'bigint' || t.amountMinor <= 0n) {
      throw new RangeError(
        `buildWalkInSaleJournal: tenders[${i}].amountMinor must be a BigInt > 0`,
      );
    }
    const accountKey = resolveReceiptAccountKeyForTender(method);
    if (!DEBIT_ACCOUNT_ORDER.includes(accountKey)) {
      // the frozen mapping could one day name an account this journal has no
      // fixed position for — fail closed rather than emit a nondeterministic line
      throw new RangeError(
        `buildWalkInSaleJournal: tender account ${accountKey} has no defined position in the walk-in journal`,
      );
    }
    debitByAccount.set(accountKey, (debitByAccount.get(accountKey) ?? 0n) + t.amountMinor);
  }

  const lines: WalkInJournalLine[] = [];
  for (const accountKey of DEBIT_ACCOUNT_ORDER) {
    const amountMinor = debitByAccount.get(accountKey);
    if (amountMinor !== undefined) lines.push({ accountKey, direction: 'debit', amountMinor });
  }
  const totalDebitMinor = lines.reduce((acc, l) => acc + l.amountMinor, 0n);
  if (totalDebitMinor !== input.totalAmountMinor) {
    throw new RangeError(
      `buildWalkInSaleJournal: tenders sum to ${totalDebitMinor}, which does not equal the sale total ${input.totalAmountMinor} (an anonymous sale must be paid in full)`,
    );
  }

  // ── credit side: net revenue + tax ────────────────────────────────────────
  const revenueMinor = input.totalAmountMinor - input.taxTotalAmountMinor;
  if (revenueMinor > 0n) {
    lines.push({ accountKey: REVENUE_ACCOUNT_KEY, direction: 'credit', amountMinor: revenueMinor });
  }
  if (input.taxTotalAmountMinor > 0n) {
    lines.push({
      accountKey: TAX_PAYABLE_ACCOUNT_KEY,
      direction: 'credit',
      amountMinor: input.taxTotalAmountMinor,
    });
  }

  const totalCreditMinor = lines
    .filter((l) => l.direction === 'credit')
    .reduce((acc, l) => acc + l.amountMinor, 0n);
  // Defence in depth: while the tender-sum check above holds, revenue + tax === total === debits,
  // so this can never fire (a mutation test proves it is equivalent, not untested). It exists so a
  // future edit to the credit side cannot silently emit an unbalanced plan.
  if (totalCreditMinor !== totalDebitMinor) {
    throw new RangeError(
      `buildWalkInSaleJournal: journal is unbalanced (debits ${totalDebitMinor} != credits ${totalCreditMinor})`,
    );
  }
  if (lines.length < 2) {
    throw new RangeError('buildWalkInSaleJournal: a journal needs at least two lines');
  }

  return Object.freeze({
    sourceKind: WALK_IN_SALE_SOURCE_KIND,
    sourceId: input.invoiceId,
    lines: Object.freeze(lines.map((l) => Object.freeze(l))),
    totalDebitMinor,
    totalCreditMinor,
  });
}
