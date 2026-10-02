import { DomainError } from '../../common/errors/domain-error.js';

/**
 * Task 3b.8 F3 — the `CreditNoteCoverageRelease` shape of ONE coverage source of an invoice being
 * cancelled, and the PURE rule that derives it for a `CustomerAdvanceApplication`. No DB, no HTTP.
 *
 * Frozen release shapes (CHECK `credit_note_coverage_release_source_shape_chk`):
 *   PAYMENT_ALLOCATION   allocation id NOT NULL, application id NULL,     sourcePaymentId NOT NULL
 *   ADVANCE_APPLICATION  allocation id NULL,     application id NOT NULL, sourcePaymentId NOT NULL
 *   OPENING_ADVANCE      allocation id NULL,     application id NOT NULL, sourcePaymentId NULL
 */
export interface CoverageSource {
  sourceKind: 'PAYMENT_ALLOCATION' | 'ADVANCE_APPLICATION' | 'OPENING_ADVANCE';
  sourcePaymentAllocationId: string | null;
  sourceAdvanceApplicationId: string | null;
  sourcePaymentId: string | null;
  amountMinor: bigint;
}

/** One `CustomerAdvanceApplication` row joined to the advance it drew on and — for a CREDIT_NOTE
 *  advance — to the ONE release that funded that advance (frozen 1:1, `customerAdvanceId` UNIQUE). */
export interface ApplicationCoverageRow {
  id: string;
  amountMinor: bigint;
  /** the underlying `CustomerAdvance.sourceType` */
  advanceSourceType: string;
  /** the underlying `CustomerAdvance.sourcePaymentId` (non-null only for a PAYMENT advance) */
  advanceSourcePaymentId: string | null;
  /** the funding release's `sourceKind` — null when no release funded the advance */
  fundingKind: string | null;
  /** the funding release's `sourcePaymentId` */
  fundingPaymentId: string | null;
}

function unresolved(row: ApplicationCoverageRow, why: string): DomainError {
  return new DomainError(
    'CREDIT_NOTE_ADVANCE_PROVENANCE_UNRESOLVED',
    `the coverage of this invoice drawn from customer advance application ${row.id} cannot be released: ${why}`,
    409,
  );
}

/**
 * The release shape of an application, by the provenance of the advance it drew on:
 *   OPENING      -> OPENING_ADVANCE, no Payment (an opening balance has none).
 *   PAYMENT      -> ADVANCE_APPLICATION carrying that advance's own Payment.
 *   CREDIT_NOTE  -> the advance has NO Payment of its own — it was funded by an earlier CreditNote's
 *                   release. That funding release already carries the AUTHORITATIVE ultimate
 *                   provenance (validated when it was inserted, immutable), so it is copied forward
 *                   exactly — kind ADVANCE_APPLICATION with the same Payment, or OPENING_ADVANCE with
 *                   none — never invented, never re-derived from the advance row, never flattened.
 * Anything missing, ambiguous or inconsistent fails closed with a clean domain error (the DB trigger
 * `fn_check_credit_note_coverage_release_integrity` is the independent backstop for a raw bypass).
 */
export function coverageSourceOfApplication(row: ApplicationCoverageRow): CoverageSource {
  const base = {
    sourcePaymentAllocationId: null,
    sourceAdvanceApplicationId: row.id,
    amountMinor: row.amountMinor,
  };
  switch (row.advanceSourceType) {
    case 'OPENING':
      return { ...base, sourceKind: 'OPENING_ADVANCE', sourcePaymentId: null };
    case 'PAYMENT':
      if (row.advanceSourcePaymentId === null) {
        throw unresolved(row, 'its PAYMENT-sourced advance has no funding Payment');
      }
      return {
        ...base,
        sourceKind: 'ADVANCE_APPLICATION',
        sourcePaymentId: row.advanceSourcePaymentId,
      };
    case 'CREDIT_NOTE':
      if (row.fundingKind === null) {
        throw unresolved(
          row,
          'its CREDIT_NOTE advance has no funding release to derive provenance from',
        );
      }
      if (row.fundingKind === 'OPENING_ADVANCE') {
        if (row.fundingPaymentId !== null) {
          throw unresolved(
            row,
            'its funding release is inconsistent (OPENING_ADVANCE with a Payment)',
          );
        }
        return { ...base, sourceKind: 'OPENING_ADVANCE', sourcePaymentId: null };
      }
      if (row.fundingKind === 'PAYMENT_ALLOCATION' || row.fundingKind === 'ADVANCE_APPLICATION') {
        if (row.fundingPaymentId === null) {
          throw unresolved(
            row,
            `its funding release is inconsistent (${row.fundingKind} without a Payment)`,
          );
        }
        return {
          ...base,
          sourceKind: 'ADVANCE_APPLICATION',
          sourcePaymentId: row.fundingPaymentId,
        };
      }
      throw unresolved(row, `its funding release has an unrecognized kind (${row.fundingKind})`);
    default:
      throw unresolved(
        row,
        `its advance has an unrecognized source type (${row.advanceSourceType})`,
      );
  }
}
