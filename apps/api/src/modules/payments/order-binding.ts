/**
 * Task 3b.5 Checkpoint A — pure Order fingerprint+version capture-staleness
 * gate. NO DB lookup here — the caller supplies both the attempt's
 * recorded-at-creation values and the live Order's current values (read
 * under the Invoice/Order lock in the later capture transaction).
 *
 * Frozen rule (owner contract round 4, §4 — explicitly preserved, not
 * weakened): BOTH the commercial-snapshot fingerprint AND the version must
 * match. Either mismatch fails closed. No tolerance for version drift in
 * 3b.5, even though `Order.version` is also bumped by pure status-only
 * transitions that leave the fingerprint unchanged — inspection of
 * `order.repository.ts` in the same contract round proved no
 * currently-implemented mutator can touch a CONFIRMED Order, so this strict
 * pairing cannot currently produce a false rejection in practice. A future
 * task introducing a legitimate post-CONFIRMED non-commercial Order
 * mutation must explicitly revisit this contract at that time — this
 * module does not preempt that redesign.
 *
 * Error convention: this module throws plain `RangeError`, matching the
 * repository's established pure-module convention (`tax-arithmetic.ts`,
 * `document-discount-allocation.ts` — no `DomainError`/HTTP status in a
 * DB/HTTP-free module). The future service layer is expected to surface a
 * mismatch here as `ORDER_COMMERCIAL_STATE_CHANGED` (409) — documented as
 * the intended code, not constructed here.
 */
export interface OrderBindingCheckInput {
  readonly expectedFingerprint: string;
  readonly liveFingerprint: string;
  readonly expectedVersion: number;
  readonly liveVersion: number;
}

export function assertPaymentAttemptOrderBinding(input: OrderBindingCheckInput): void {
  const fingerprintMatches = input.expectedFingerprint === input.liveFingerprint;
  const versionMatches = input.expectedVersion === input.liveVersion;
  if (!fingerprintMatches || !versionMatches) {
    throw new RangeError(
      'the Order has changed since this PaymentAttempt was created ' +
        `(fingerprint match: ${fingerprintMatches}, version match: ${versionMatches})`,
    );
  }
}
