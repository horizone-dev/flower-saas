import { Money } from '@flower/money';
import { Quantity } from '@flower/uom';
import { DomainError } from '../../common/errors/domain-error.js';
import { allocateDocumentDiscount } from '../orders/document-discount-allocation.js';
import { resolveReceiptAccountKeyForTender } from '../payments/tender-account-mapping.js';

/**
 * Phase 3B closure — RB-1 A2 (owner decision 2026-11-11): the PURE core of the anonymous credit note. No database, no clock, no
 * framework, no float: exact `bigint` arithmetic only. Everything is derived from the order line's OWN frozen snapshot
 * (`unitPriceAmountMinor`, `quantity`, `discountAmountMinor`, `lineTaxAmountMinor`, `priceTaxMode`) plus a deterministic replay of the
 * frozen `allocateDocumentDiscount` over those same inputs — never a live tax or catalog lookup — so the VAT reversed can never differ
 * from the VAT the sale declared.
 *
 * PARTIAL credits follow the frozen schema's own rule (`schema.prisma` `CreditNoteLine`): a component is
 * `floor(frozenComponent × qC / qO)`, EXCEPT the credit that exhausts a line's remaining quantity, which consumes the EXACT remainder
 * of every component (frozen − already credited) so no rounding dust is ever left over or over-credited. The database enforces the
 * same bounds independently (migration `20261105120000`).
 *
 * The journal plans below use ONLY existing account keys (`REVENUE.SALES`, `LIABILITY.TAX_PAYABLE`, `ASSET.PAYMENT_CLEARING`,
 * `ASSET.CASH_ON_HAND`, `ASSET.BANK`) and the frozen net-of-discount convention (`REVENUE.SALES = total − tax`).
 */

export const ANONYMOUS_CREDIT_NOTE_SOURCE_KIND = 'anonymous_credit_note' as const;
export const ANONYMOUS_REFUND_EXECUTION_SOURCE_KIND = 'anonymous_credit_note_refund' as const;

export const REASON_CODES = [
  'CUSTOMER_REQUEST',
  'DUPLICATE',
  'PRICING_ERROR',
  'DAMAGED',
  'SERVICE_NOT_DELIVERED',
  'ORDER_ERROR',
  'OTHER',
] as const;
export type ReasonCode = (typeof REASON_CODES)[number];

/** the manual tenders an anonymous sale can have used (provider-backed tenders cannot reach an anonymous sale) */
export const REFUND_METHODS = ['CASH', 'BANK_TRANSFER', 'CARD_TERMINAL', 'OTHER_MANUAL'] as const;
export type RefundMethod = (typeof REFUND_METHODS)[number];

export const FAILURE_REASON_CODES = [
  'TERMINAL_DECLINED',
  'CUSTOMER_UNAVAILABLE',
  'CASH_UNAVAILABLE',
  'BANK_REJECTED',
  'OTHER',
] as const;
export type FailureReasonCode = (typeof FAILURE_REASON_CODES)[number];

// ───────────────────────── the credit plan ─────────────────────────

export interface FrozenOrderLine {
  readonly id: string;
  readonly linePosition: number;
  /** the ordered quantity, 4 decimal places, e.g. "3.0000" */
  readonly quantity: string;
  readonly unitPriceAmountMinor: bigint;
  readonly discountAmountMinor: bigint;
  readonly priceTaxMode: string | null;
  readonly lineTaxAmountMinor: bigint | null;
}

/** what earlier credit notes already consumed of one order line */
export interface PriorLineCredit {
  /** scaled quantity (×10 000) */
  readonly quantityScaled: bigint;
  readonly grossMinor: bigint;
  readonly discountMinor: bigint;
  readonly documentDiscountShareMinor: bigint;
  readonly taxMinor: bigint;
}

export interface RequestedCreditLine {
  readonly orderLineId: string;
  /** the quantity to credit, 4 decimal places maximum, e.g. "1" or "0.5000" */
  readonly quantity: string;
}

export interface PlannedCreditLine {
  readonly orderLineId: string;
  readonly quantityCredited: string; // toFixed4
  readonly grossCreditedMinor: bigint;
  readonly discountCreditedMinor: bigint;
  readonly documentDiscountShareCreditedMinor: bigint;
  readonly netAfterDocumentDiscountCreditedMinor: bigint;
  readonly taxCreditedMinor: bigint;
  readonly lineTotalCreditedMinor: bigint;
}

export interface CreditPlan {
  readonly lines: readonly PlannedCreditLine[];
  /** Σ net after document discount */
  readonly subtotalAmountMinor: bigint;
  readonly taxTotalAmountMinor: bigint;
  readonly totalAmountMinor: bigint;
}

const SCALE = 10_000n;

const invalid = (code: string, message: string): DomainError => new DomainError(code, message, 422);

export function planAnonymousCreditNote(input: {
  readonly currencyCode: string;
  readonly orderDocumentDiscountMinor: bigint;
  /** EVERY line of the order (the document-discount replay needs them all) */
  readonly orderLines: readonly FrozenOrderLine[];
  readonly priorByLine: ReadonlyMap<string, PriorLineCredit>;
  readonly requested: readonly RequestedCreditLine[];
}): CreditPlan {
  const { currencyCode } = input;
  if (input.requested.length === 0)
    throw invalid('CREDIT_NOTE_NO_LINES', 'a credit note needs at least one line');
  const seen = new Set<string>();
  for (const r of input.requested) {
    if (seen.has(r.orderLineId))
      throw invalid(
        'CREDIT_NOTE_DUPLICATE_LINE',
        'an order line may appear only once in a credit note',
      );
    seen.add(r.orderLineId);
  }

  // frozen full-quantity components, exactly as the frozen 3b.8 derivation computes them
  const frozen = input.orderLines.map((l) => {
    const qScaled = Quantity.parse(l.quantity).scaled;
    const gross = Money.ofMinor(l.unitPriceAmountMinor, currencyCode).mulRatio(
      qScaled,
      SCALE,
    ).amountMinor;
    const afterLineDiscount = gross - l.discountAmountMinor;
    return { line: l, qScaled, gross, afterLineDiscount };
  });
  const allocation = allocateDocumentDiscount(
    frozen.map((f) => ({
      linePosition: f.line.linePosition,
      commercialAmountAfterLineDiscountMinor: f.afterLineDiscount,
    })),
    input.orderDocumentDiscountMinor,
    currencyCode,
  );
  const shareByPosition = new Map(
    allocation.lines.map((l) => [l.linePosition, l.documentDiscountShareMinor]),
  );
  const byId = new Map(frozen.map((f) => [f.line.id, f]));

  const planned: PlannedCreditLine[] = input.requested.map((r) => {
    const f = byId.get(r.orderLineId);
    if (!f)
      throw invalid(
        'CREDIT_NOTE_LINE_NOT_IN_ORDER',
        'an order line does not belong to the credited sale',
      );
    let qC: bigint;
    try {
      qC = Quantity.parse(r.quantity).scaled;
    } catch {
      throw invalid('CREDIT_NOTE_QUANTITY_INVALID', 'a credited quantity is not a valid quantity');
    }
    if (qC <= 0n)
      throw invalid('CREDIT_NOTE_QUANTITY_INVALID', 'a credited quantity must be positive');
    const prior = input.priorByLine.get(f.line.id) ?? {
      quantityScaled: 0n,
      grossMinor: 0n,
      discountMinor: 0n,
      documentDiscountShareMinor: 0n,
      taxMinor: 0n,
    };
    const remaining = f.qScaled - prior.quantityScaled;
    if (qC > remaining)
      throw invalid(
        'CREDIT_NOTE_QUANTITY_EXCEEDS_REMAINING',
        'a credited quantity exceeds what remains creditable on the line',
      );
    const isFinal = qC === remaining;

    const frozenShare = shareByPosition.get(f.line.linePosition) ?? 0n;
    const frozenTax = f.line.lineTaxAmountMinor ?? 0n;
    const part = (frozenValue: bigint, priorValue: bigint): bigint =>
      isFinal ? frozenValue - priorValue : (frozenValue * qC) / f.qScaled; // non-negative operands → integer division is floor

    const gross = part(f.gross, prior.grossMinor);
    const discount = part(f.line.discountAmountMinor, prior.discountMinor);
    const share = part(frozenShare, prior.documentDiscountShareMinor);
    const tax = part(frozenTax, prior.taxMinor);
    const net = gross - discount - share;
    if (net < 0n || tax < 0n)
      throw invalid(
        'CREDIT_NOTE_NEGATIVE_COMPONENT',
        'the credit would produce a negative component',
      );
    const lineTotal = f.line.priceTaxMode === 'TAX_INCLUSIVE' ? net : net + tax;
    return {
      orderLineId: f.line.id,
      quantityCredited: Quantity.ofScaled(qC).toFixed4(),
      grossCreditedMinor: gross,
      discountCreditedMinor: discount,
      documentDiscountShareCreditedMinor: share,
      netAfterDocumentDiscountCreditedMinor: net,
      taxCreditedMinor: tax,
      lineTotalCreditedMinor: lineTotal,
    };
  });

  const sum = (pick: (l: PlannedCreditLine) => bigint): bigint =>
    planned.reduce((a, l) => a + pick(l), 0n);
  const totalAmountMinor = sum((l) => l.lineTotalCreditedMinor);
  if (totalAmountMinor <= 0n)
    throw invalid('CREDIT_NOTE_ZERO_TOTAL', 'the credit total must be positive');
  return {
    lines: planned,
    subtotalAmountMinor: sum((l) => l.netAfterDocumentDiscountCreditedMinor),
    taxTotalAmountMinor: sum((l) => l.taxCreditedMinor),
    totalAmountMinor,
  };
}

// ───────────────────────── refund validation ─────────────────────────

export interface RefundRequest {
  readonly method: RefundMethod;
  readonly amountMinor: bigint;
}

/**
 * Validate the refund lines of a NEW credit note (their sum must equal the credit total exactly) against what each tender paid
 * and what earlier non-failed refunds already used. Returns the lines unchanged; throws one typed error otherwise.
 */
export function validateInitialRefunds(input: {
  readonly totalAmountMinor: bigint;
  readonly refunds: readonly RefundRequest[];
  readonly paidByMethod: ReadonlyMap<string, bigint>;
  readonly usedByMethod: ReadonlyMap<string, bigint>;
}): readonly RefundRequest[] {
  const sum = input.refunds.reduce((a, r) => a + r.amountMinor, 0n);
  if (sum !== input.totalAmountMinor)
    throw invalid('REFUND_TOTAL_MISMATCH', 'the refund lines must sum to the credit total exactly');
  assertWithinTenderCaps(input);
  return input.refunds;
}

/** the per-tender cap: per method, (already used + requested) ≤ what that tender paid for the invoice */
export function assertWithinTenderCaps(input: {
  readonly refunds: readonly RefundRequest[];
  readonly paidByMethod: ReadonlyMap<string, bigint>;
  readonly usedByMethod: ReadonlyMap<string, bigint>;
}): void {
  const requested = new Map<string, bigint>();
  for (const r of input.refunds) {
    if (r.amountMinor <= 0n)
      throw invalid('REFUND_AMOUNT_INVALID', 'a refund amount must be positive');
    requested.set(r.method, (requested.get(r.method) ?? 0n) + r.amountMinor);
  }
  for (const [method, amount] of requested) {
    const paid = input.paidByMethod.get(method) ?? 0n;
    const used = input.usedByMethod.get(method) ?? 0n;
    if (used + amount > paid)
      throw invalid('REFUND_EXCEEDS_TENDER', 'a refund exceeds what that tender paid for the sale');
  }
}

// ───────────────────────── journal plans ─────────────────────────

export interface PlannedJournalLine {
  readonly accountKey: string;
  readonly direction: 'debit' | 'credit';
  readonly amountMinor: bigint;
}

/**
 * ISSUANCE — one balanced entry: the revenue and the tax of the credited goods are reversed and the refund is booked IN FLIGHT on
 * `ASSET.PAYMENT_CLEARING` (the frozen in-flight account of 3b.8's own pending refunds). Cash / bank are NOT credited yet: a refund is
 * never reported executed — nor money booked as having left a tender account — before its execution is attested.
 *   Dr REVENUE.SALES (total − tax) · Dr LIABILITY.TAX_PAYABLE (tax) / Cr ASSET.PAYMENT_CLEARING (total)
 */
export function issuanceJournalLines(
  totalMinor: bigint,
  taxMinor: bigint,
): readonly PlannedJournalLine[] {
  const revenue = totalMinor - taxMinor;
  return [
    ...(revenue > 0n
      ? [{ accountKey: 'REVENUE.SALES', direction: 'debit' as const, amountMinor: revenue }]
      : []),
    ...(taxMinor > 0n
      ? [
          {
            accountKey: 'LIABILITY.TAX_PAYABLE',
            direction: 'debit' as const,
            amountMinor: taxMinor,
          },
        ]
      : []),
    { accountKey: 'ASSET.PAYMENT_CLEARING', direction: 'credit' as const, amountMinor: totalMinor },
  ];
}

/**
 * EXECUTION of one attested refund line. The tender account is the frozen receipt mapping (CASH → CASH_ON_HAND, BANK_TRANSFER → BANK,
 * manual card / other → PAYMENT_CLEARING). For cash and bank the in-flight credit is converted into the real tender credit
 * (`Dr ASSET.PAYMENT_CLEARING / Cr <tender account>`). For a manual card / other tender the sale itself debited `PAYMENT_CLEARING`, so
 * the issuance credit already IS the final effect: no journal (`null`).
 */
export function executionJournalLines(
  method: RefundMethod,
  amountMinor: bigint,
): readonly PlannedJournalLine[] | null {
  const tenderAccount = resolveReceiptAccountKeyForTender(method);
  if (tenderAccount === 'ASSET.PAYMENT_CLEARING') return null;
  return [
    { accountKey: 'ASSET.PAYMENT_CLEARING', direction: 'debit', amountMinor },
    { accountKey: tenderAccount, direction: 'credit', amountMinor },
  ];
}

/** Σ debits = Σ credits (the pure self-check used by the tests) */
export function isBalanced(lines: readonly PlannedJournalLine[]): boolean {
  let d = 0n;
  let c = 0n;
  for (const l of lines) {
    if (l.amountMinor <= 0n) return false;
    if (l.direction === 'debit') d += l.amountMinor;
    else c += l.amountMinor;
  }
  return d === c && d > 0n;
}
