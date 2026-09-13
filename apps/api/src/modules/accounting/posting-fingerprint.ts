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
    }),
  );
  return createHash('sha256').update(canonical).digest('hex');
}
