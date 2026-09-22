-- Phase 3b task 3b.5 CHECKPOINT F — narrow, additive follow-up to Checkpoint
-- B's frozen `20260923120000_payments_core` migration (same one-frozen-
-- artifact-per-checkpoint policy as Checkpoint E's own follow-up). Adds the
-- explicit, strongly-typed, immutable routing columns Checkpoint F's
-- reliable async processing needs on `provider_payment_event` — a genuine
-- schema gap confirmed by inspection (owner §F7): B intentionally stored
-- only `scope / providerCredentialId / providerEventId / eventType /
-- receivedAt / payloadHash / status / sanitizedMetadata`, with no durable,
-- strongly-typed field naming WHICH PaymentAttempt a verified event targets
-- or WHAT state it verified — `sanitizedMetadata` is arbitrary untrusted-
-- shape JSON and is explicitly forbidden from being the authoritative
-- business-routing source (owner §F7).
--
-- ══════════════ GAP — no durable normalized routing columns ═════════════
ALTER TABLE "provider_payment_event"
  ADD COLUMN "paymentAttemptId" UUID,
  ADD COLUMN "providerReference" TEXT,
  ADD COLUMN "targetState" TEXT;

-- targetState is restricted to the frozen PaymentAttempt vocabulary MINUS
-- the refund states (owner §F5/§F7: "refund states not accepted as
-- F-processing targets") — NULL is allowed for an unsupported-but-verified
-- event persisted directly as EXCEPTION with no PaymentAttempt target
-- (owner §F7's explicit allowance).
ALTER TABLE "provider_payment_event"
  ADD CONSTRAINT "provider_payment_event_targetState_chk"
  CHECK ("targetState" IS NULL OR "targetState" IN
    ('PENDING', 'REQUIRES_ACTION', 'AUTHORIZED', 'CAPTURED', 'FAILED', 'CANCELED'));

-- structural scope integrity (owner §F7 "appropriate FK/scope integrity"):
-- when paymentAttemptId is present, it must be a PaymentAttempt within the
-- EXACT SAME tenant/company/branch as this inbox row — never a
-- cross-scope attempt id. A NULL paymentAttemptId trivially satisfies a
-- composite FK (Postgres MATCH SIMPLE), matching the "nullable target"
-- requirement for an EXCEPTION-only event with no PaymentAttempt.
ALTER TABLE "provider_payment_event"
  ADD CONSTRAINT "provider_payment_event_attempt_scope_fkey"
  FOREIGN KEY ("tenantId", "companyId", "branchId", "paymentAttemptId")
  REFERENCES "payment_attempt" ("tenantId", "companyId", "branchId", "id")
  ON UPDATE CASCADE ON DELETE RESTRICT;

CREATE INDEX "provider_payment_event_paymentAttemptId_idx"
  ON "provider_payment_event"("paymentAttemptId");

-- ══════════════ immutability — extend the EXISTING B trigger to also
-- protect the 3 new columns ═══════════════════════════════════════════════
-- Checkpoint B's `fn_enforce_provider_payment_event_transition` is an
-- EXPLICIT column-by-column comparison (not a generic row diff) — a new
-- column added without updating it would NOT be protected by "only status
-- may change" and could be silently altered after insert. `CREATE OR
-- REPLACE FUNCTION` here is a new, additive migration file; it does not
-- rewrite B's own migration.sql on disk, only redefines the function's
-- behavior going forward — the standard, safe way to evolve trigger logic
-- across migrations without touching a frozen prior file.
CREATE OR REPLACE FUNCTION fn_enforce_provider_payment_event_transition() RETURNS trigger AS $$
BEGIN
  IF NOT (
    NEW."tenantId" IS NOT DISTINCT FROM OLD."tenantId"
    AND NEW."companyId" IS NOT DISTINCT FROM OLD."companyId"
    AND NEW."branchId" IS NOT DISTINCT FROM OLD."branchId"
    AND NEW."providerCredentialId" IS NOT DISTINCT FROM OLD."providerCredentialId"
    AND NEW."providerEventId" IS NOT DISTINCT FROM OLD."providerEventId"
    AND NEW."eventType" IS NOT DISTINCT FROM OLD."eventType"
    AND NEW."receivedAt" IS NOT DISTINCT FROM OLD."receivedAt"
    AND NEW."payloadHash" IS NOT DISTINCT FROM OLD."payloadHash"
    AND NEW."sanitizedMetadata" IS NOT DISTINCT FROM OLD."sanitizedMetadata"
    AND NEW."paymentAttemptId" IS NOT DISTINCT FROM OLD."paymentAttemptId"
    AND NEW."providerReference" IS NOT DISTINCT FROM OLD."providerReference"
    AND NEW."targetState" IS NOT DISTINCT FROM OLD."targetState"
  ) THEN
    RAISE EXCEPTION 'provider_payment_event %: only status may change', OLD."id";
  END IF;

  IF NEW."status" IS NOT DISTINCT FROM OLD."status" THEN
    RETURN NEW;
  END IF;

  IF OLD."status" = 'RECEIVED' AND NEW."status" IN ('PROCESSED', 'EXCEPTION') THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'provider_payment_event %: illegal status transition % -> %', OLD."id", OLD."status", NEW."status";
END;
$$ LANGUAGE plpgsql;
