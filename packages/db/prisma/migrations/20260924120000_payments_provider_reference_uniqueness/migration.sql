-- Phase 3b task 3b.5 CHECKPOINT E — narrow, additive follow-up to Checkpoint
-- B's frozen `20260923120000_payments_core` migration. Two structural gaps
-- exposed by designing the async PaymentAttempt / provider-reservation flow
-- (Checkpoint E, still pre-release — no rewrite of B's own migration file,
-- per repository migration policy of one frozen artifact per checkpoint).
-- Index-only. No new table. No trigger. No RLS change (RLS already applies
-- to `payment_attempt` from Checkpoint B; an index adds no new access path).
--
-- ══════════════ GAP 1 — providerReference reuse across attempts ════════════
-- Checkpoint B declared `payment_attempt.providerReference` as plain
-- nullable TEXT with only a narrow set-once UPDATE trigger (NULL -> non-NULL
-- once; same value harmless; different replacement blocked). Nothing
-- prevented the SAME non-null providerReference from being written onto TWO
-- DIFFERENT payment_attempt rows under the SAME provider credential — a real
-- integration defect for safe provider-event reconciliation (Checkpoint F
-- would have no way to know which attempt a webhook event actually belongs
-- to if two attempts share a reference). Fixed with a partial unique index,
-- scoped to `providerCredentialId` (never globally unique across different
-- credentials/accounts — two different merchants/providers may legitimately
-- reuse the same provider-side reference value).
CREATE UNIQUE INDEX "payment_attempt_provider_credential_reference_key"
  ON "payment_attempt"("providerCredentialId", "providerReference")
  WHERE "providerReference" IS NOT NULL AND "providerCredentialId" IS NOT NULL;

-- ══════════════ GAP 2 — two-phase async attempt creation is not itself
-- idempotent at the DB level ═════════════════════════════════════════════
-- Checkpoint E's async attempt creation commits its reservation (Phase 1) in
-- its OWN transaction, separate from the external provider call and the
-- later Phase-2 transaction that applies the provider's result. If the
-- overall HTTP handler subsequently fails for any reason AFTER Phase 1 has
-- already committed (e.g. a deliberately-forced Phase-2 failure, or a
-- process crash), the shared `IdempotencyRepository` either deletes its own
-- claim row (`release`, on a thrown handler error) or leaves a stale
-- claim that a later retry may reclaim and re-execute from scratch — in
-- EITHER case a naive retry with the SAME Idempotency-Key would re-run Phase
-- 1 and could create a SECOND, duplicate PaymentAttempt reservation for the
-- same logical request, double-reserving the invoice's available balance.
-- This risk is specific to a flow whose first phase durably commits before
-- the request as a whole is known to have succeeded — Checkpoints C/D never
-- had it, because their single transaction is fully atomic with the request
-- (a failure there rolls back everything, so a retry starts genuinely
-- fresh). The fix makes Phase 1 itself idempotent at the DB level: a unique
-- constraint on `(tenantId, createdByUserId, idempotencyKey)` lets Phase 1
-- use `INSERT ... ON CONFLICT DO NOTHING RETURNING ...` and safely discover
-- (rather than duplicate) an already-reserved attempt from a prior partial
-- execution of the same logical request by the same actor. `createdByUserId`
-- stands in for the HTTP-layer's own `principalId` (no such column existed
-- on this table before; reusing the existing attribution column avoids
-- adding a new one).
--
-- PARTIAL, scoped to `"providerCredentialId" IS NOT NULL` — Checkpoint C/D's
-- own synchronous Multi Payment primitive
-- (`PaymentCollectionRepository.captureSynchronousTendersInTx`) legitimately
-- inserts MULTIPLE `payment_attempt` rows (one per tender component) that
-- all share the SAME `idempotencyKey`/`createdByUserId` in a single request
-- — those rows always have `providerCredentialId IS NULL` (C/D never sets
-- it). An unscoped (full-table) unique index on this triple would collide
-- with that already-frozen, already-shipped pattern (confirmed directly: the
-- full Checkpoint C/D regression suite was run against the first, unscoped
-- version of this index, and every Multi Payment request failed with a
-- unique violation — restored to green only after adding this predicate).
-- Scoping to `providerCredentialId IS NOT NULL` makes the constraint apply
-- ONLY to Checkpoint E's own provider-backed async attempts
-- (`providerCredentialId` is a required field there), leaving every C/D row
-- entirely outside this index.
CREATE UNIQUE INDEX "payment_attempt_tenantId_createdByUserId_idempotencyKey_key"
  ON "payment_attempt"("tenantId", "createdByUserId", "idempotencyKey")
  WHERE "providerCredentialId" IS NOT NULL;
