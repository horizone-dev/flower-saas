import {
  computeCommercialSnapshotFingerprintByVersion,
  type CommercialSnapshotInput,
  type CommercialSnapshotLine,
} from '../orders/commercial-snapshot.js';
import { parseMinorUnitsText } from './report-money.js';

/**
 * Task 3b.10 Checkpoint B correction (owner correction 1) — the IMMUTABLE AUTHORITY of `lineDiscountMinor`.
 *
 * ── The problem ────────────────────────────────────────────────────────────────────────────────
 * The Sales report sums `order_line.discountAmountMinor` of each invoice's order. The database freezes an
 * issued order's lines against UPDATE and DELETE, but an `INSERT` of an extra line into an already-issued
 * order is NOT trigger-guarded — and no stored invoice field holds the line-discount total (the invoice keeps
 * only Σ(gross − line discount), which a crafted line with a zero net amount preserves exactly). "No product
 * path does that" is not a financial proof.
 *
 * ── The authority ──────────────────────────────────────────────────────────────────────────────
 * `order.commercialSnapshotFingerprint` (+ its immutable `commercialSnapshotFingerprintVersion`) is a SHA-256
 * over the canonical commercial snapshot of the order — the ORDERED full line array (each line's price,
 * quantity, UOM conversion, discount mode / bps / amount and tax references), the document discount, the
 * ids and the fiscal policy. Issuance recomputes it from the locked line set and refuses to issue unless it
 * equals the stored value (`ORDER_FINGERPRINT_MISMATCH` path), and the order's commercial-freeze trigger
 * then forbids ANY later change of it. So it is a persisted, issuance-verified, DB-frozen digest of exactly
 * the line set the invoice was issued from.
 *
 * ── The proof ──────────────────────────────────────────────────────────────────────────────────
 * For every invoice of the report, the CURRENT order lines (read in the same statement, the same snapshot) are
 * fed to the ONE shared fingerprint function (`computeCommercialSnapshotFingerprintByVersion` — imported, never
 * re-implemented, no second hashing implementation) and the result must equal the stored fingerprint. An extra
 * line (any discount, any value, even all-zero), a deleted line, a changed discount / quantity / price, or a
 * reordering changes the digest, so none of them can alter a successful report undetected. It is not a count
 * check and not a sum check: a crafted line cannot preserve a SHA-256 over the whole set.
 *
 * Only a line set that PROVES itself contributes: the per-branch line discount computed here from the verified
 * lines must also equal the statement's own aggregate (a second, independent sum) — and any failure fails the
 * whole report closed; a figure from an unverified line set is never returned.
 *
 * Pure: no database, no clock, no catalogue, no current price, no tax or amount recomputation — the verified
 * lines are only the carrier of the stored `discountAmountMinor`.
 */

/** The order columns the commercial fingerprint is built from (read from the immutable order row). */
export interface InvoiceOrderFacts {
  readonly tenantId: string;
  readonly companyId: string;
  readonly originBranchId: string;
  readonly fulfillingBranchId: string;
  readonly customerId: string | null;
  readonly kind: string;
  readonly currencyCode: string;
  readonly documentDiscountMode: string;
  readonly documentDiscountBps: number | null;
  readonly documentDiscountAmountMinor: string;
  readonly documentDiscountReason: string | null;
  readonly taxPriceMode: string;
  readonly taxRoundingScope: string;
  readonly taxRoundingMode: string;
  readonly commercialSnapshotFingerprint: string;
  readonly commercialSnapshotFingerprintVersion: number;
}

/**
 * One order line, positional (ORDER BY linePosition): the 17 fingerprint-bound columns after the position.
 *   0 linePosition · 1 productId · 2 variantId · 3 quantity · 4 selectedUomCode · 5 baseUomCode ·
 *   6 conversionNumerator · 7 conversionDenominator · 8 unitPriceAmountMinor · 9 unitPriceCurrencyCode ·
 *   10 unitPriceCurrencyExponent · 11 discountMode · 12 discountBps · 13 discountAmountMinor ·
 *   14 taxCategoryKey · 15 rateBps · 16 effectiveFrom · 17 resolutionSource
 */
export type InvoiceLineTuple = readonly unknown[];

/** What the report statement returns for ONE invoice of the period. */
export interface InvoiceLineSetFacts {
  readonly invoiceId: string;
  readonly branchId: string;
  /** null when the invoice's order row could not be read — always a failure */
  readonly order: InvoiceOrderFacts | null;
  readonly lines: readonly InvoiceLineTuple[];
}

export interface InvoiceLineSetProof {
  /** invoices whose line set did NOT prove itself (fingerprint differs, shape invalid, order unreadable, …) */
  readonly mismatches: number;
  /** per branch: the line discount of the VERIFIED invoices only */
  readonly lineDiscountByBranch: ReadonlyMap<string, bigint>;
  /** per branch: how many invoices verified */
  readonly verifiedInvoicesByBranch: ReadonlyMap<string, number>;
}

const LINE_FIELDS = 18;
const DISCOUNT_AMOUNT = 13;

function text(value: unknown): string {
  if (typeof value !== 'string') throw new TypeError('expected text');
  return value;
}
function textOrNull(value: unknown): string | null {
  return value === null ? null : text(value);
}
function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value))
    throw new TypeError('expected integer');
  return value;
}
function integerOrNull(value: unknown): number | null {
  return value === null ? null : integer(value);
}

function snapshotLine(tuple: InvoiceLineTuple): CommercialSnapshotLine {
  if (tuple.length !== LINE_FIELDS) throw new TypeError('malformed line');
  return {
    productId: text(tuple[1]),
    variantId: text(tuple[2]),
    quantity: text(tuple[3]),
    selectedUomCode: text(tuple[4]),
    baseUomCode: text(tuple[5]),
    conversionNumerator: text(tuple[6]),
    conversionDenominator: text(tuple[7]),
    unitPriceAmountMinor: text(tuple[8]),
    unitPriceCurrencyCode: text(tuple[9]),
    unitPriceCurrencyExponent: integer(tuple[10]),
    discountMode: text(tuple[11]),
    discountBps: integerOrNull(tuple[12]),
    discountAmountMinor: text(tuple[13]),
    taxCategoryKey: textOrNull(tuple[14]),
    rateBps: integerOrNull(tuple[15]),
    effectiveFrom: textOrNull(tuple[16]),
    resolutionSource: text(tuple[17]),
  };
}

/** Returns the invoice's verified line discount, or null when its line set does not prove itself. */
function verifyOne(facts: InvoiceLineSetFacts): bigint | null {
  const order = facts.order;
  if (order === null || facts.lines.length < 1) return null;
  // the invoice's branch is the order's ORIGIN branch (a database-enforced fact of issuance)
  if (order.originBranchId !== facts.branchId) return null;

  const lines = facts.lines.map(snapshotLine);
  const input: CommercialSnapshotInput = {
    tenantId: text(order.tenantId),
    companyId: text(order.companyId),
    originBranchId: text(order.originBranchId),
    fulfillingBranchId: text(order.fulfillingBranchId),
    customerId: textOrNull(order.customerId),
    kind: text(order.kind),
    currencyCode: text(order.currencyCode),
    lines,
    documentDiscountMode: text(order.documentDiscountMode),
    documentDiscountBps: integerOrNull(order.documentDiscountBps),
    documentDiscountAmountMinor: text(order.documentDiscountAmountMinor),
    documentDiscountReason: textOrNull(order.documentDiscountReason),
  };
  const recomputed = computeCommercialSnapshotFingerprintByVersion(
    integer(order.commercialSnapshotFingerprintVersion),
    input,
    {
      taxPriceMode: text(order.taxPriceMode),
      taxRoundingScope: text(order.taxRoundingScope),
      taxRoundingMode: text(order.taxRoundingMode),
    },
  );
  if (recomputed !== text(order.commercialSnapshotFingerprint)) return null;

  let discount = 0n;
  for (const tuple of facts.lines) {
    discount += parseMinorUnitsText(text(tuple[DISCOUNT_AMOUNT]), 'order line discountAmountMinor');
  }
  return discount;
}

/**
 * Verify the line set of every invoice. Never throws on malformed input — a line set that cannot be read,
 * hashed or matched is simply NOT proven (counted in `mismatches`) and never contributes a figure.
 */
export function verifyInvoiceLineSets(facts: readonly InvoiceLineSetFacts[]): InvoiceLineSetProof {
  let mismatches = 0;
  const lineDiscountByBranch = new Map<string, bigint>();
  const verifiedInvoicesByBranch = new Map<string, number>();
  for (const f of facts) {
    let discount: bigint | null;
    try {
      discount = verifyOne(f);
    } catch {
      discount = null;
    }
    if (discount === null) {
      mismatches += 1;
      continue;
    }
    lineDiscountByBranch.set(f.branchId, (lineDiscountByBranch.get(f.branchId) ?? 0n) + discount);
    verifiedInvoicesByBranch.set(f.branchId, (verifiedInvoicesByBranch.get(f.branchId) ?? 0) + 1);
  }
  return { mismatches, lineDiscountByBranch, verifiedInvoicesByBranch };
}

/**
 * The statement's own per-branch aggregates against the VERIFIED lines: the invoice count and the line
 * discount of every branch must equal what the proven line sets give (and no proven set may belong to a branch
 * the aggregates do not know). Returns the number of branches that disagree.
 */
export function lineDiscountCrossCheckFailures(
  aggregates: readonly {
    readonly branchId: string;
    readonly invoiceCount: number;
    readonly lineDiscount: bigint;
  }[],
  proof: InvoiceLineSetProof,
): number {
  let failures = 0;
  const known = new Set<string>();
  for (const a of aggregates) {
    known.add(a.branchId);
    if (a.invoiceCount !== (proof.verifiedInvoicesByBranch.get(a.branchId) ?? 0)) failures += 1;
    else if (a.lineDiscount !== (proof.lineDiscountByBranch.get(a.branchId) ?? 0n)) failures += 1;
  }
  for (const branchId of proof.verifiedInvoicesByBranch.keys()) {
    if (!known.has(branchId)) failures += 1;
  }
  return failures;
}
