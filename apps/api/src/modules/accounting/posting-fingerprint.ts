import { createHash } from 'node:crypto';
import { canonicalize } from '../../common/idempotency/canonical-hash.js';

export interface PostingFingerprintLine {
  accountKey: string;
  direction: 'debit' | 'credit';
  amountMinor: bigint;
}

export interface PostingFingerprintInput {
  companyId: string;
  sourceKind: string;
  sourceId: string;
  currencyCode: string;
  lines: PostingFingerprintLine[];
  branchId: string | null;
  posTerminalId: string | null;
  /**
   * Task 3b.6 Checkpoint F Absolute Final Freeze Gate (§1/§3) — the caller's
   * own EXPLICITLY supplied `accountingDate` (`PostJournalInput.accountingDate`),
   * `null` when omitted. `null` here means "not supplied" and is DELIBERATELY
   * excluded from the canonical object entirely (see `computePostingFingerprint`
   * below) — `canonicalize()` only drops `undefined`-valued keys, never `null`,
   * so passing the literal `null` straight through would add a NEW key to
   * every pre-F caller's canonical shape and change every legacy stored
   * `postingFingerprint`, breaking idempotent replay for any journal posted
   * before this field existed. Converting `null` -> `undefined` before
   * building the canonical object makes the omitted-date canonical shape
   * BYTE-IDENTICAL to the pre-F canonical shape (which never had this key),
   * so every legacy fingerprint remains valid with no DB rewrite. An
   * EXPLICITLY supplied date DOES participate (the key is present), so the
   * same source posted with a different explicit date is a genuine content
   * conflict, and an omitted-date fingerprint never collides with any
   * explicit-date fingerprint for the same source (different canonical
   * shapes).
   */
  accountingDate: string | null;
}

/**
 * Deterministic canonical-content hash for a posting request — detects a
 * same-source-identity-different-content conflict (`JOURNAL_SOURCE_CONFLICT`).
 * Distinct in PURPOSE from the HTTP `Idempotency-Key` fingerprint
 * (`canonical-hash.ts`'s `requestHash`, which guards client retry-safety for
 * an HTTP request) even though it reuses the same `canonicalize()` primitive —
 * this guards a different invariant: "the same business source event must
 * always resolve to the same accounting content." Lines are sorted so line
 * order never affects the hash (only content is semantic here).
 */
export function computePostingFingerprint(input: PostingFingerprintInput): string {
  const sortedLines = [...input.lines]
    .sort(
      (a, b) => a.accountKey.localeCompare(b.accountKey) || a.direction.localeCompare(b.direction),
    )
    .map((l) => ({
      accountKey: l.accountKey,
      direction: l.direction,
      amountMinor: l.amountMinor.toString(),
    }));
  const canonical = JSON.stringify(
    canonicalize({
      companyId: input.companyId,
      sourceKind: input.sourceKind,
      sourceId: input.sourceId,
      currencyCode: input.currencyCode,
      lines: sortedLines,
      branchId: input.branchId,
      posTerminalId: input.posTerminalId,
      // `null` (omitted) -> `undefined` so `canonicalize()` drops the key
      // entirely, keeping the omitted-date canonical shape byte-identical
      // to every pre-F fingerprint (see the field doc on `accountingDate`
      // above for why this is required for legacy compatibility).
      accountingDate: input.accountingDate ?? undefined,
    }),
  );
  return createHash('sha256').update(canonical).digest('hex');
}
