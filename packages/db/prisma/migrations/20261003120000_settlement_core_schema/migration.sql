-- Phase 3b task 3b.7 CHECKPOINT B — provider settlement reconciliation core
-- schema (docs/phase-3/PHASE-3B-PLAN.md). Additive, forward-only. Three new
-- tables — no HTTP API / CSV ingestion / matching service / finalization
-- service / Invoice SETTLED projection anywhere in this migration (all
-- Checkpoint C/D). Schema + DB structural invariants + RLS only.
--
-- NOTE ON SCOPE: `prisma migrate dev --create-only` against the current
-- schema.prisma also surfaces a large amount of PRE-EXISTING drift between
-- schema.prisma's own Prisma-generated constraint/index naming and this
-- repo's convention of hand-shortened names in already-applied migrations
-- (catalog/orders/customer tables) — none of that is related to Settlement
-- and none of it is included here. This migration contains ONLY the
-- `settlement_batch` / `settlement_line` / `settlement_application` schema.
--
--   settlement_batch       — one provider payout/settlement report.
--   settlement_line        — one provider-reported line, evidence only.
--   settlement_application — the ONLY financial settlement-consumption
--                            authority (DB-enforced 1:1 with its Line).
--
-- ══════════════ FINALIZED-batch DB-enforced completeness (A-O) ═════════════
-- Mirrors the `journal_entry` sealed/balanced trigger set
-- (20260915120000_accounting_coa_posting_periods) exactly: a single
-- `CONSTRAINT TRIGGER ... AFTER INSERT OR UPDATE OF "state" ...
-- DEFERRABLE INITIALLY DEFERRED`, firing on BOTH a direct
-- `INSERT ... (state='FINALIZED', ...)` AND a legitimate `DRAFT->FINALIZED`
-- UPDATE, re-SELECTing the batch's CURRENT committed-transaction state at
-- commit time (never trusting the insert/update-time `NEW` snapshot). Proven
-- against:
--   A. every SettlementLine matched                        -> checked
--   B. line count = application count                      -> checked
--   C. exactly one Application per Line (B + lineId UNIQUE) -> checked
--   D. Application/Line same batch                          -> checked (also
--      immediate trigger, defense-in-depth)
--   E. Application.paymentId = Line.matchedPaymentId         -> checked (also
--      immediate trigger)
--   F. Application Money = Line Money                        -> checked (also
--      immediate trigger)
--   G. gross = SUM(Line.amountMinor)                         -> checked
--   H. gross = SUM(Application.amountMinor)                  -> checked
--   I. gross = net + fee                                     -> checked (also
--      CHECK constraint, defense-in-depth)
--   J. journalEntryId IS NOT NULL                             -> checked
--   K. referenced JournalEntry belongs EXACTLY to this batch
--      ((tenantId,companyId,sourceKind,sourceId) reuses the existing
--      journal_entry unique authority — sourceKind='SETTLEMENT_BATCH',
--      sourceId=batch id)                                    -> checked
--   L. Journal postingDate = providerSettlementDate,
--      currencyCode = batch currencyCode, sealedAt IS NOT NULL -> checked
--   M. every settlement JournalLine carries branchId = batch.branchId
--      and posTerminalId IS NULL (settlement is not POS-shift activity)
--                                                              -> checked
--   N. exact 3-account economic shape: Bank debit=net (0 legs omitted when
--      net=0), Fee debit=fee (0 legs omitted when fee=0), Clearing
--      credit=gross, zero cross-direction/other-account usage, physical
--      line count = 1 + (net>0?1:0) + (fee>0?1:0)             -> checked
--   O. FINALIZED implies finalizedAt IS NOT NULL               -> checked
--      (also settlement_batch_finalized_at_state_chk CHECK, defense-in-depth)
-- The pre-existing `journal_entry`/`journal_line` sealed+balanced+minimum-2-
-- line trigger set is NOT duplicated here — reused as-is; this migration
-- verifies only the settlement-specific linkage + economic shape on top of it.
--
-- ══════════════ APPLICATION/BATCH TWO-PHASE STATE GATE (Checkpoint B final
-- correction) ════════════════════════════════════════════════════════════
-- The corrected finalize order (Applications + Journal posted WHILE the
-- Batch is still DRAFT, THEN one atomic DRAFT->FINALIZED UPDATE as the
-- transaction's last statement) means an immediate "parent must be
-- FINALIZED" Application-insert check is impossible — the whole point is
-- that it is NOT yet FINALIZED at insert time. Two triggers instead:
--   phase 1 (immediate, BEFORE INSERT, inside fn_check_settlement_application_
--     integrity) — parent Batch must be CURRENTLY DRAFT. Rejects a "late"
--     Application inserted directly against an already-FINALIZED batch.
--   phase 2 (deferred, AFTER INSERT, DEFERRABLE INITIALLY DEFERRED,
--     fn_check_settlement_application_parent_finalized) — parent Batch must
--     be FINALIZED by COMMIT. Rejects a Batch left DRAFT (finalize
--     abandoned) after an Application was inserted against it.
-- Net effect: an Application can be committed ONLY as part of the same
-- transaction that finalizes its own parent Batch — never against a Batch
-- that stays DRAFT, never as a later addition to an already-FINALIZED Batch.
--
-- ══════════════ CONCURRENCY-SAFE BACKSTOPS ══════════════════════════════════
-- `fn_lock_and_validate_payment_settlement_capacity` mirrors the frozen
-- `fn_lock_and_validate_payment_capacity` pattern
-- (20260927130000_receivables_core_schema) — locks `payment` FOR UPDATE,
-- sums existing `settlement_application` consumption, rejects if the
-- proposed amount would exceed `payment.amountMinor`. A provider Payment may
-- be partially settled across multiple batches; no over-settlement. This is
-- a SEPARATE consumption ceiling from the existing payment_allocation /
-- customer_advance capacity function — settlement reconciles against actual
-- bank deposits, an orthogonal dimension to how the payment was allocated.
--
-- `settlement_application` insertion (Checkpoint D's finalize transaction)
-- locks `payment` FOR UPDATE via this function — the SAME row the frozen
-- Checkpoint-A concurrency protocol locks in its own extended lock tier
-- (Payments + the CustomerAdvance rows they fund), so no new lock-order rule
-- is introduced here; this migration adds no code that acquires a lock
-- ahead of Invoice.
--
-- `fn_lock_and_validate_advance_capacity` (customer_advance's own capacity
-- backstop, 20260927130000_receivables_core_schema) is verified UNCHANGED —
-- it already locks `customer_advance` FOR UPDATE before validating; nothing
-- in this migration touches that function or its trigger.

-- ── CreateTable — settlement_batch ───────────────────────────────────────────
CREATE TABLE "settlement_batch" (
    "id"                     UUID NOT NULL DEFAULT uuidv7(),
    "tenantId"               UUID NOT NULL,
    "companyId"              UUID NOT NULL,
    "branchId"               UUID NOT NULL,
    "providerCredentialId"   UUID NOT NULL,
    "externalSettlementId"   TEXT NOT NULL,
    "providerSettlementDate" DATE NOT NULL,
    "grossSettlementMinor"   BIGINT NOT NULL,
    "providerFeeMinor"       BIGINT NOT NULL,
    "netBankMinor"           BIGINT NOT NULL,
    "currencyCode"           TEXT NOT NULL,
    "currencyExponent"       SMALLINT NOT NULL,
    "state"                  TEXT NOT NULL DEFAULT 'DRAFT',
    "version"                INTEGER NOT NULL DEFAULT 1,
    "journalEntryId"         UUID,
    "createdByUserId"        UUID,
    "createdAt"              TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finalizedAt"            TIMESTAMPTZ(6),

    CONSTRAINT "settlement_batch_pkey" PRIMARY KEY ("id")
);

-- ── CreateTable — settlement_line ────────────────────────────────────────────
CREATE TABLE "settlement_line" (
    "id"                 UUID NOT NULL DEFAULT uuidv7(),
    "tenantId"           UUID NOT NULL,
    "companyId"          UUID NOT NULL,
    "branchId"           UUID NOT NULL,
    "batchId"            UUID NOT NULL,
    "externalLineId"     TEXT,
    "providerReference"  TEXT,
    "amountMinor"        BIGINT NOT NULL,
    "currencyCode"       TEXT NOT NULL,
    "currencyExponent"   SMALLINT NOT NULL,
    "matchedPaymentId"   UUID,
    "lineKind"           TEXT NOT NULL DEFAULT 'SETTLEMENT',
    "createdAt"          TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "settlement_line_pkey" PRIMARY KEY ("id")
);

-- ── CreateTable — settlement_application ─────────────────────────────────────
CREATE TABLE "settlement_application" (
    "id"               UUID NOT NULL DEFAULT uuidv7(),
    "tenantId"         UUID NOT NULL,
    "companyId"        UUID NOT NULL,
    "branchId"         UUID NOT NULL,
    "batchId"          UUID NOT NULL,
    "lineId"           UUID NOT NULL,
    "paymentId"        UUID NOT NULL,
    "amountMinor"      BIGINT NOT NULL,
    "currencyCode"     TEXT NOT NULL,
    "currencyExponent" SMALLINT NOT NULL,
    "createdAt"        TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "settlement_application_pkey" PRIMARY KEY ("id")
);

-- ── CreateIndex ───────────────────────────────────────────────────────────────
CREATE UNIQUE INDEX "settlement_batch_journalEntryId_key" ON "settlement_batch"("journalEntryId");
CREATE INDEX "settlement_batch_tenantId_companyId_branchId_idx" ON "settlement_batch"("tenantId", "companyId", "branchId");
CREATE UNIQUE INDEX "settlement_batch_tenantId_id_key" ON "settlement_batch"("tenantId", "id");
CREATE UNIQUE INDEX "settlement_batch_tenantId_companyId_id_key" ON "settlement_batch"("tenantId", "companyId", "id");
CREATE UNIQUE INDEX "settlement_batch_tenantId_companyId_branchId_id_key" ON "settlement_batch"("tenantId", "companyId", "branchId", "id");
CREATE UNIQUE INDEX "settlement_batch_providerCredentialId_externalSettlementId_key" ON "settlement_batch"("providerCredentialId", "externalSettlementId");

CREATE INDEX "settlement_line_batchId_idx" ON "settlement_line"("batchId");
CREATE INDEX "settlement_line_matchedPaymentId_idx" ON "settlement_line"("matchedPaymentId");
CREATE UNIQUE INDEX "settlement_line_tenantId_id_key" ON "settlement_line"("tenantId", "id");
-- NULL-distinct by ordinary SQL semantics — multiple NULL externalLineId rows
-- in the same batch never collide; two non-NULL equal values in the SAME
-- batch collide, the same value in a DIFFERENT batch never collides. No
-- partial index needed.
CREATE UNIQUE INDEX "settlement_line_batchId_externalLineId_key" ON "settlement_line"("batchId", "externalLineId");

CREATE UNIQUE INDEX "settlement_application_lineId_key" ON "settlement_application"("lineId");
CREATE INDEX "settlement_application_batchId_idx" ON "settlement_application"("batchId");
CREATE INDEX "settlement_application_paymentId_idx" ON "settlement_application"("paymentId");
CREATE UNIQUE INDEX "settlement_application_tenantId_id_key" ON "settlement_application"("tenantId", "id");

-- ── AddForeignKey — plain single-column FKs ──────────────────────────────────
ALTER TABLE "settlement_batch"
  ADD CONSTRAINT "settlement_batch_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenant"("id") ON UPDATE CASCADE ON DELETE CASCADE,
  ADD CONSTRAINT "settlement_batch_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "company"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  ADD CONSTRAINT "settlement_batch_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branch"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  ADD CONSTRAINT "settlement_batch_providerCredentialId_fkey" FOREIGN KEY ("providerCredentialId") REFERENCES "provider_credential"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  ADD CONSTRAINT "settlement_batch_journalEntryId_fkey" FOREIGN KEY ("journalEntryId") REFERENCES "journal_entry"("id") ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE "settlement_line"
  ADD CONSTRAINT "settlement_line_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenant"("id") ON UPDATE CASCADE ON DELETE CASCADE,
  ADD CONSTRAINT "settlement_line_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "company"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  ADD CONSTRAINT "settlement_line_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branch"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  ADD CONSTRAINT "settlement_line_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "settlement_batch"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  ADD CONSTRAINT "settlement_line_matchedPaymentId_fkey" FOREIGN KEY ("matchedPaymentId") REFERENCES "payment"("id") ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE "settlement_application"
  ADD CONSTRAINT "settlement_application_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenant"("id") ON UPDATE CASCADE ON DELETE CASCADE,
  ADD CONSTRAINT "settlement_application_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "company"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  ADD CONSTRAINT "settlement_application_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branch"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  ADD CONSTRAINT "settlement_application_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "settlement_batch"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  ADD CONSTRAINT "settlement_application_lineId_fkey" FOREIGN KEY ("lineId") REFERENCES "settlement_line"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  ADD CONSTRAINT "settlement_application_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "payment"("id") ON UPDATE CASCADE ON DELETE RESTRICT;

-- ── AddForeignKey — composite tenant/company/branch/currency-safe FKs ────────
ALTER TABLE "settlement_batch"
  ADD CONSTRAINT "settlement_batch_company_tenant_fkey"
    FOREIGN KEY ("tenantId", "companyId") REFERENCES "company"("tenantId", "id") ON UPDATE NO ACTION ON DELETE NO ACTION,
  ADD CONSTRAINT "settlement_batch_branch_tenant_company_fkey"
    FOREIGN KEY ("tenantId", "companyId", "branchId") REFERENCES "branch"("tenantId", "companyId", "id") ON UPDATE NO ACTION ON DELETE NO ACTION,
  ADD CONSTRAINT "settlement_batch_currency_company_fkey"
    FOREIGN KEY ("tenantId", "companyId", "currencyCode") REFERENCES "company"("tenantId", "id", "defaultCurrency") ON UPDATE RESTRICT ON DELETE NO ACTION,
  ADD CONSTRAINT "settlement_batch_currency_exponent_fkey"
    FOREIGN KEY ("currencyCode", "currencyExponent") REFERENCES "currency"("code", "exponent") ON UPDATE RESTRICT ON DELETE NO ACTION;

ALTER TABLE "settlement_line"
  ADD CONSTRAINT "settlement_line_company_tenant_fkey"
    FOREIGN KEY ("tenantId", "companyId") REFERENCES "company"("tenantId", "id") ON UPDATE NO ACTION ON DELETE NO ACTION,
  ADD CONSTRAINT "settlement_line_branch_tenant_company_fkey"
    FOREIGN KEY ("tenantId", "companyId", "branchId") REFERENCES "branch"("tenantId", "companyId", "id") ON UPDATE NO ACTION ON DELETE NO ACTION,
  ADD CONSTRAINT "settlement_line_batch_tenant_company_branch_fkey"
    FOREIGN KEY ("tenantId", "companyId", "branchId", "batchId") REFERENCES "settlement_batch"("tenantId", "companyId", "branchId", "id") ON UPDATE NO ACTION ON DELETE NO ACTION,
  ADD CONSTRAINT "settlement_line_matched_payment_tenant_company_branch_fkey"
    FOREIGN KEY ("tenantId", "companyId", "branchId", "matchedPaymentId") REFERENCES "payment"("tenantId", "companyId", "branchId", "id") ON UPDATE NO ACTION ON DELETE NO ACTION,
  ADD CONSTRAINT "settlement_line_currency_company_fkey"
    FOREIGN KEY ("tenantId", "companyId", "currencyCode") REFERENCES "company"("tenantId", "id", "defaultCurrency") ON UPDATE RESTRICT ON DELETE NO ACTION,
  ADD CONSTRAINT "settlement_line_currency_exponent_fkey"
    FOREIGN KEY ("currencyCode", "currencyExponent") REFERENCES "currency"("code", "exponent") ON UPDATE RESTRICT ON DELETE NO ACTION;

ALTER TABLE "settlement_application"
  ADD CONSTRAINT "settlement_application_company_tenant_fkey"
    FOREIGN KEY ("tenantId", "companyId") REFERENCES "company"("tenantId", "id") ON UPDATE NO ACTION ON DELETE NO ACTION,
  ADD CONSTRAINT "settlement_application_branch_tenant_company_fkey"
    FOREIGN KEY ("tenantId", "companyId", "branchId") REFERENCES "branch"("tenantId", "companyId", "id") ON UPDATE NO ACTION ON DELETE NO ACTION,
  ADD CONSTRAINT "settlement_application_batch_tenant_company_branch_fkey"
    FOREIGN KEY ("tenantId", "companyId", "branchId", "batchId") REFERENCES "settlement_batch"("tenantId", "companyId", "branchId", "id") ON UPDATE NO ACTION ON DELETE NO ACTION,
  ADD CONSTRAINT "settlement_application_payment_tenant_company_branch_fkey"
    FOREIGN KEY ("tenantId", "companyId", "branchId", "paymentId") REFERENCES "payment"("tenantId", "companyId", "branchId", "id") ON UPDATE NO ACTION ON DELETE NO ACTION,
  ADD CONSTRAINT "settlement_application_currency_company_fkey"
    FOREIGN KEY ("tenantId", "companyId", "currencyCode") REFERENCES "company"("tenantId", "id", "defaultCurrency") ON UPDATE RESTRICT ON DELETE NO ACTION,
  ADD CONSTRAINT "settlement_application_currency_exponent_fkey"
    FOREIGN KEY ("currencyCode", "currencyExponent") REFERENCES "currency"("code", "exponent") ON UPDATE RESTRICT ON DELETE NO ACTION;

-- ── CHECK constraints — defense-in-depth value shape ─────────────────────────
ALTER TABLE "settlement_batch"
  ADD CONSTRAINT "settlement_batch_state_chk" CHECK ("state" IN ('DRAFT', 'FINALIZED')),
  ADD CONSTRAINT "settlement_batch_gross_positive_chk" CHECK ("grossSettlementMinor" > 0),
  ADD CONSTRAINT "settlement_batch_fee_nonneg_chk" CHECK ("providerFeeMinor" >= 0),
  ADD CONSTRAINT "settlement_batch_net_nonneg_chk" CHECK ("netBankMinor" >= 0),
  ADD CONSTRAINT "settlement_batch_gross_eq_net_plus_fee_chk" CHECK ("grossSettlementMinor" = "netBankMinor" + "providerFeeMinor"),
  ADD CONSTRAINT "settlement_batch_external_id_nonempty_chk" CHECK (length(btrim("externalSettlementId")) > 0),
  -- item 10 (Checkpoint B final correction) — DRAFT <=> finalizedAt IS NULL,
  -- FINALIZED <=> finalizedAt IS NOT NULL. Same-row, no cross-table lookup
  -- needed, so an immediate CHECK suffices (no trigger required); the
  -- deferred completeness trigger re-asserts the FINALIZED-side half as its
  -- own invariant O, defense-in-depth, mirroring the gross=net+fee pattern.
  ADD CONSTRAINT "settlement_batch_finalized_at_state_chk" CHECK (
    ("state" = 'DRAFT' AND "finalizedAt" IS NULL)
    OR ("state" = 'FINALIZED' AND "finalizedAt" IS NOT NULL)
  );

ALTER TABLE "settlement_line"
  ADD CONSTRAINT "settlement_line_amount_positive_chk" CHECK ("amountMinor" > 0),
  ADD CONSTRAINT "settlement_line_kind_chk" CHECK ("lineKind" = 'SETTLEMENT');

ALTER TABLE "settlement_application"
  ADD CONSTRAINT "settlement_application_amount_positive_chk" CHECK ("amountMinor" > 0);

-- ══════════════════════ settlement_batch — provider credential scope ═══════
-- Mirrors `fn_check_payment_attempt_provider_credential_scope`
-- (20260923120000_payments_core) exactly: the referenced ProviderCredential
-- must be branch-scoped (companyId AND branchId both NOT NULL) and must
-- EXACTLY match this row's own tenant/company/branch. Fires whenever
-- providerCredentialId is written (INSERT, or an UPDATE of that column while
-- still DRAFT — the separate immutability trigger below blocks any change
-- once FINALIZED).
CREATE FUNCTION fn_check_settlement_batch_provider_credential_scope() RETURNS trigger AS $$
DECLARE
  cred RECORD;
BEGIN
  SELECT * INTO cred FROM "provider_credential" WHERE "id" = NEW."providerCredentialId";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'settlement_batch %: referenced providerCredentialId % does not exist', NEW."id", NEW."providerCredentialId";
  END IF;
  IF cred."tenantId" IS DISTINCT FROM NEW."tenantId" THEN
    RAISE EXCEPTION 'settlement_batch %: providerCredentialId % belongs to a different tenant', NEW."id", NEW."providerCredentialId";
  END IF;
  IF cred."companyId" IS NULL OR cred."branchId" IS NULL THEN
    RAISE EXCEPTION 'settlement_batch %: providerCredentialId % must be branch-scoped for settlement (companyId and branchId both required)', NEW."id", NEW."providerCredentialId";
  END IF;
  IF cred."companyId" IS DISTINCT FROM NEW."companyId" THEN
    RAISE EXCEPTION 'settlement_batch %: providerCredentialId % is scoped to a different company', NEW."id", NEW."providerCredentialId";
  END IF;
  IF cred."branchId" IS DISTINCT FROM NEW."branchId" THEN
    RAISE EXCEPTION 'settlement_batch %: providerCredentialId % is scoped to a different branch', NEW."id", NEW."providerCredentialId";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_check_settlement_batch_provider_credential_scope
  BEFORE INSERT OR UPDATE OF "providerCredentialId" ON "settlement_batch"
  FOR EACH ROW EXECUTE FUNCTION fn_check_settlement_batch_provider_credential_scope();

-- ══════════════════════ settlement_batch — FINALIZED immutability ══════════
-- Once state = FINALIZED: no identity/financial/linkage field may change, and
-- FINALIZED -> anything-else (including back to DRAFT) is rejected. FINALIZED
-- is terminal in 3b.7 — no reopen path exists anywhere in this schema.
CREATE FUNCTION fn_enforce_settlement_batch_immutable_after_finalized() RETURNS trigger AS $$
BEGIN
  IF OLD."state" != 'FINALIZED' THEN
    RETURN NEW;
  END IF;
  IF NEW."tenantId" = OLD."tenantId"
     AND NEW."companyId" = OLD."companyId"
     AND NEW."branchId" = OLD."branchId"
     AND NEW."providerCredentialId" = OLD."providerCredentialId"
     AND NEW."externalSettlementId" = OLD."externalSettlementId"
     AND NEW."providerSettlementDate" = OLD."providerSettlementDate"
     AND NEW."grossSettlementMinor" = OLD."grossSettlementMinor"
     AND NEW."providerFeeMinor" = OLD."providerFeeMinor"
     AND NEW."netBankMinor" = OLD."netBankMinor"
     AND NEW."currencyCode" = OLD."currencyCode"
     AND NEW."currencyExponent" = OLD."currencyExponent"
     AND NEW."state" = OLD."state"
     AND NEW."journalEntryId" IS NOT DISTINCT FROM OLD."journalEntryId"
     AND NEW."finalizedAt" IS NOT DISTINCT FROM OLD."finalizedAt"
     AND NEW."version" = OLD."version"
  THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'settlement_batch %: is FINALIZED — no identity/financial/linkage field may change, and FINALIZED is terminal (no reopen)', OLD."id";
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_enforce_settlement_batch_immutable_after_finalized
  BEFORE UPDATE ON "settlement_batch"
  FOR EACH ROW EXECUTE FUNCTION fn_enforce_settlement_batch_immutable_after_finalized();

-- ══════════════════════ settlement_line — scope/currency + FINALIZED gate ══
-- INSERT: line tenant/company/branch must equal parent batch's own scope
-- (defense-in-depth on top of the composite FK above, which already proves
-- this structurally); line currency/exponent must equal parent batch's
-- currency/exponent; the parent batch must not already be FINALIZED (B14/
-- item-14 gate).
CREATE FUNCTION fn_check_settlement_line_scope_and_state() RETURNS trigger AS $$
DECLARE
  batch RECORD;
BEGIN
  SELECT * INTO batch FROM "settlement_batch" WHERE "id" = NEW."batchId";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'settlement_line %: referenced batchId % does not exist', NEW."id", NEW."batchId";
  END IF;
  IF batch."state" = 'FINALIZED' THEN
    RAISE EXCEPTION 'settlement_line %: batch % is already FINALIZED — no new line may be inserted', NEW."id", NEW."batchId";
  END IF;
  IF batch."tenantId" IS DISTINCT FROM NEW."tenantId"
     OR batch."companyId" IS DISTINCT FROM NEW."companyId"
     OR batch."branchId" IS DISTINCT FROM NEW."branchId"
  THEN
    RAISE EXCEPTION 'settlement_line %: scope does not match batch %''s own scope', NEW."id", NEW."batchId";
  END IF;
  IF batch."currencyCode" IS DISTINCT FROM NEW."currencyCode" OR batch."currencyExponent" IS DISTINCT FROM NEW."currencyExponent" THEN
    RAISE EXCEPTION 'settlement_line %: currency does not match batch %''s own currency', NEW."id", NEW."batchId";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_check_settlement_line_scope_and_state
  BEFORE INSERT ON "settlement_line"
  FOR EACH ROW EXECUTE FUNCTION fn_check_settlement_line_scope_and_state();

-- UPDATE/DELETE: mutable while parent batch is DRAFT (matching/unmatching a
-- Payment, correcting a mis-parsed line, etc.) — rejected once the parent is
-- FINALIZED. This is a CONDITIONAL (parent-state-gated) append-only rule,
-- unlike journal_line's unconditional one, because a Line is evidence
-- collected and refined during the DRAFT matching phase.
CREATE FUNCTION fn_enforce_settlement_line_immutable_after_finalized() RETURNS trigger AS $$
DECLARE
  batch_state TEXT;
  ref_batch_id UUID;
BEGIN
  ref_batch_id := COALESCE(NEW."batchId", OLD."batchId");
  SELECT "state" INTO batch_state FROM "settlement_batch" WHERE "id" = ref_batch_id;
  IF batch_state = 'FINALIZED' THEN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'settlement_line %: batch % is FINALIZED — DELETE is never permitted', OLD."id", ref_batch_id;
    ELSE
      RAISE EXCEPTION 'settlement_line %: batch % is FINALIZED — UPDATE is never permitted', OLD."id", ref_batch_id;
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_enforce_settlement_line_immutable_after_finalized
  BEFORE UPDATE OR DELETE ON "settlement_line"
  FOR EACH ROW EXECUTE FUNCTION fn_enforce_settlement_line_immutable_after_finalized();

-- ══════════════════════ settlement payment capacity backstop ═══════════════
-- Mirrors `fn_lock_and_validate_payment_capacity`
-- (20260927130000_receivables_core_schema) exactly, as a SEPARATE ceiling:
-- settlement consumption is tracked in `settlement_application`, independent
-- of `payment_allocation` / `customer_advance` consumption. A Payment may be
-- partially settled across multiple batches; no over-settlement.
CREATE FUNCTION fn_lock_and_validate_payment_settlement_capacity(p_payment_id UUID, p_proposed_amount BIGINT) RETURNS void AS $$
DECLARE
  payment_amount BIGINT;
  consumed BIGINT;
BEGIN
  SELECT "amountMinor" INTO payment_amount FROM "payment" WHERE "id" = p_payment_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'payment %: does not exist', p_payment_id;
  END IF;
  SELECT COALESCE(SUM("amountMinor"), 0) INTO consumed FROM "settlement_application" WHERE "paymentId" = p_payment_id;
  IF consumed + p_proposed_amount > payment_amount THEN
    RAISE EXCEPTION 'payment %: settlement consumption would exceed amountMinor (payment=%, already settled=%, proposed=%)', p_payment_id, payment_amount, consumed, p_proposed_amount;
  END IF;
END;
$$ LANGUAGE plpgsql;

-- ══════════════════════ settlement_application — integrity + eligibility ═══
-- Checkpoint B final correction — TWO-PHASE Application/Batch state gate,
-- modeling Application as a finalization-ONLY fact without a FINALIZING
-- state: (1) this BEFORE INSERT trigger requires the parent Batch to be
-- CURRENTLY DRAFT at insert time — an insert directly against an
-- already-FINALIZED batch (a "late" Application) is rejected immediately,
-- with no wait for commit; (2) the SEPARATE deferred constraint trigger
-- below (`trg_check_settlement_application_parent_finalized`) requires the
-- parent to be FINALIZED by COMMIT — an Application inserted into a batch
-- that is then left DRAFT (finalize abandoned) is rejected at commit. Only
-- "insert while DRAFT, then finalize the SAME batch in the SAME
-- transaction" satisfies both phases. This is what makes the corrected
-- finalize order legal: SettlementApplication rows, the Settlement Journal,
-- and the Invoice/Payment/CustomerAdvance locks are all established WHILE
-- the Batch is still DRAFT, and the ONE atomic DRAFT->FINALIZED UPDATE
-- (with journalEntryId/finalizedAt/version all attached) is the LAST
-- statement of the transaction.
--
-- BEFORE INSERT: verifies the referenced Line (same batch, matchedPaymentId
-- = this Application's paymentId and NOT NULL, Money equality, scope
-- equality), that the parent Batch is currently DRAFT, THEN proves the
-- Payment is settlement-eligible (provider-backed — providerKey IS NOT
-- NULL; scope matches the batch; the Payment's OWN funding credential — via
-- sourceAttemptId -> PaymentAttempt.providerCredentialId — matches this
-- batch's providerCredentialId, never merely the same providerKey under a
-- different credential; currency matches) THEN locks + validates settlement
-- capacity. `fn_lock_and_validate_payment_settlement_capacity` sums ALL
-- `settlement_application` rows for the Payment with NO batch-state filter
-- (deliberately — every committed row is proven, by the deferred gate, to
-- belong to a FINALIZED batch, and an in-flight sibling Application inserted
-- earlier in the SAME finalize transaction must also count immediately even
-- though the batch is still DRAFT at that point). Canonical order:
-- Line/scope/money/state checks first (cheap, no lock), THEN the capacity
-- lock (expensive, serializing) — mirrors
-- `fn_check_customer_advance_application_integrity`'s own ordering.
CREATE FUNCTION fn_check_settlement_application_integrity() RETURNS trigger AS $$
DECLARE
  line RECORD;
  batch RECORD;
  pay RECORD;
  attempt_credential_id UUID;
BEGIN
  SELECT * INTO line FROM "settlement_line" WHERE "id" = NEW."lineId";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'settlement_application %: referenced lineId % does not exist', NEW."id", NEW."lineId";
  END IF;
  IF line."batchId" IS DISTINCT FROM NEW."batchId" THEN
    RAISE EXCEPTION 'settlement_application %: batchId does not match line %''s own batchId', NEW."id", NEW."lineId";
  END IF;
  IF line."matchedPaymentId" IS NULL THEN
    RAISE EXCEPTION 'settlement_application %: line % has no matchedPaymentId', NEW."id", NEW."lineId";
  END IF;
  IF line."matchedPaymentId" IS DISTINCT FROM NEW."paymentId" THEN
    RAISE EXCEPTION 'settlement_application %: paymentId does not match line %''s matchedPaymentId', NEW."id", NEW."lineId";
  END IF;
  IF line."amountMinor" IS DISTINCT FROM NEW."amountMinor"
     OR line."currencyCode" IS DISTINCT FROM NEW."currencyCode"
     OR line."currencyExponent" IS DISTINCT FROM NEW."currencyExponent"
  THEN
    RAISE EXCEPTION 'settlement_application %: money does not match line %''s own money', NEW."id", NEW."lineId";
  END IF;
  IF line."tenantId" IS DISTINCT FROM NEW."tenantId"
     OR line."companyId" IS DISTINCT FROM NEW."companyId"
     OR line."branchId" IS DISTINCT FROM NEW."branchId"
  THEN
    RAISE EXCEPTION 'settlement_application %: scope does not match line %''s own scope', NEW."id", NEW."lineId";
  END IF;

  SELECT * INTO batch FROM "settlement_batch" WHERE "id" = NEW."batchId";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'settlement_application %: referenced batchId % does not exist', NEW."id", NEW."batchId";
  END IF;
  IF batch."state" != 'DRAFT' THEN
    RAISE EXCEPTION 'settlement_application %: batch % is not DRAFT (state=%) — an Application may only be inserted while its parent Batch is still DRAFT, as the same transaction that goes on to finalize it', NEW."id", NEW."batchId", batch."state";
  END IF;

  SELECT * INTO pay FROM "payment" WHERE "id" = NEW."paymentId";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'settlement_application %: referenced paymentId % does not exist', NEW."id", NEW."paymentId";
  END IF;
  IF pay."providerKey" IS NULL THEN
    RAISE EXCEPTION 'settlement_application %: payment % is not provider-backed (providerKey is NULL) — CASH/BANK_TRANSFER/OTHER_MANUAL are never settlement-eligible', NEW."id", NEW."paymentId";
  END IF;
  IF pay."tenantId" IS DISTINCT FROM batch."tenantId"
     OR pay."companyId" IS DISTINCT FROM batch."companyId"
     OR pay."branchId" IS DISTINCT FROM batch."branchId"
  THEN
    RAISE EXCEPTION 'settlement_application %: payment %''s scope does not match batch %''s own scope', NEW."id", NEW."paymentId", NEW."batchId";
  END IF;
  IF pay."currencyCode" IS DISTINCT FROM batch."currencyCode" OR pay."currencyExponent" IS DISTINCT FROM batch."currencyExponent" THEN
    RAISE EXCEPTION 'settlement_application %: payment %''s currency does not match batch %''s own currency', NEW."id", NEW."paymentId", NEW."batchId";
  END IF;

  SELECT "providerCredentialId" INTO attempt_credential_id FROM "payment_attempt" WHERE "id" = pay."sourceAttemptId";
  IF attempt_credential_id IS DISTINCT FROM batch."providerCredentialId" THEN
    RAISE EXCEPTION 'settlement_application %: payment %''s funding providerCredentialId does not match batch %''s providerCredentialId — same providerKey under another credential is not sufficient', NEW."id", NEW."paymentId", NEW."batchId";
  END IF;

  PERFORM fn_lock_and_validate_payment_settlement_capacity(NEW."paymentId", NEW."amountMinor");

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_check_settlement_application_integrity
  BEFORE INSERT ON "settlement_application"
  FOR EACH ROW EXECUTE FUNCTION fn_check_settlement_application_integrity();

-- ══════════════════════ settlement_application — append-only ═══════════════
-- Unconditional — an Application, once it exists (whether still inside its
-- own in-flight finalize transaction or long since committed), is NEVER
-- updated or deleted. It may be INSERTed only while its parent Batch is
-- DRAFT (immediate gate above) and only survives COMMIT if that same Batch
-- became FINALIZED in the same transaction (deferred gate below) — but
-- nothing ever mutates or removes an Application row after its own INSERT
-- statement, unlike settlement_line, which has a genuine DRAFT-phase
-- mutability window (matching/unmatching).
CREATE FUNCTION fn_enforce_settlement_application_append_only() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'settlement_application is append-only: DELETE is never permitted (id=%)', OLD."id";
  ELSE
    RAISE EXCEPTION 'settlement_application is append-only: UPDATE is never permitted (id=%)', OLD."id";
  END IF;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_enforce_settlement_application_append_only
  BEFORE UPDATE OR DELETE ON "settlement_application"
  FOR EACH ROW EXECUTE FUNCTION fn_enforce_settlement_application_append_only();

-- ══════════════════════ settlement_application — parent-finality gate ══════
-- Checkpoint B final correction, phase 2 of the two-phase gate (see the
-- integrity-trigger header comment above for phase 1). Deferred to COMMIT,
-- re-SELECTing the parent Batch's CURRENT state — never trusting any
-- snapshot taken at INSERT time, since the whole point is that the Batch's
-- own state legitimately CHANGES (DRAFT -> FINALIZED) later in the SAME
-- transaction. Closes exactly the gap phase 1 cannot: phase 1 only proves
-- the Batch WAS DRAFT at the moment of INSERT; it cannot know whether the
-- transaction goes on to finalize that Batch or abandons it (COMMITs with
-- the Batch left DRAFT) — this trigger proves the latter can never survive
-- COMMIT. An Application can therefore NEVER be observed, by any other
-- transaction, attached to a DRAFT Batch.
CREATE FUNCTION fn_check_settlement_application_parent_finalized() RETURNS trigger AS $$
DECLARE
  batch_state TEXT;
BEGIN
  SELECT "state" INTO batch_state FROM "settlement_batch" WHERE "id" = NEW."batchId";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'settlement_application %: referenced batchId % does not exist at commit', NEW."id", NEW."batchId";
  END IF;
  IF batch_state != 'FINALIZED' THEN
    RAISE EXCEPTION 'settlement_application %: parent batch % was left % at commit — an Application must never survive commit unless its parent Batch is FINALIZED in the SAME transaction', NEW."id", NEW."batchId", batch_state;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER trg_check_settlement_application_parent_finalized
  AFTER INSERT ON "settlement_application"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION fn_check_settlement_application_parent_finalized();

-- ══════════════════════ settlement_batch — FINALIZED completeness (A-N) ════
-- See header comment for the full proof table. Deferred to COMMIT, fired
-- once per INSERT-or-UPDATE-of-state row event; re-SELECTs the row's CURRENT
-- state by id rather than trusting the NEW snapshot — closes the direct
-- `INSERT ... (state='FINALIZED', ...)` bypass the same way
-- `trg_check_journal_entry_sealed_and_balanced` closes it for journal_entry.
CREATE FUNCTION fn_check_settlement_batch_finalized_complete() RETURNS trigger AS $$
DECLARE
  b RECORD;
  je RECORD;
  line_count BIGINT;
  application_count BIGINT;
  unmatched_count BIGINT;
  mismatched_count BIGINT;
  line_total NUMERIC;
  application_total NUMERIC;
  expected_line_count INT;
  je_line_count BIGINT;
  bad_branch_or_pos_count BIGINT;
  bank_account_id UUID;
  fee_account_id UUID;
  clearing_account_id UUID;
  bank_debit NUMERIC;
  bank_credit NUMERIC;
  fee_debit NUMERIC;
  fee_credit NUMERIC;
  clearing_debit NUMERIC;
  clearing_credit NUMERIC;
  other_account_count BIGINT;
BEGIN
  SELECT * INTO b FROM "settlement_batch" WHERE "id" = NEW."id";
  IF b."state" != 'FINALIZED' THEN
    RETURN NULL;
  END IF;

  -- O — FINALIZED implies finalizedAt IS NOT NULL. Redundant with the
  -- immediate settlement_batch_finalized_at_state_chk CHECK constraint
  -- (defense-in-depth, same pattern as gross=net+fee being both a CHECK and
  -- a re-asserted deferred invariant).
  IF b."finalizedAt" IS NULL THEN
    RAISE EXCEPTION 'settlement_batch %: is FINALIZED but finalizedAt is NULL at commit', b."id";
  END IF;

  -- A/B/C — every Line matched; line count = application count (combined
  -- with the settlement_application_lineId_key UNIQUE constraint this proves
  -- EXACTLY one Application per Line, not merely at-most-one).
  SELECT COUNT(*) INTO line_count FROM "settlement_line" WHERE "batchId" = b."id";
  SELECT COUNT(*) INTO unmatched_count FROM "settlement_line" WHERE "batchId" = b."id" AND "matchedPaymentId" IS NULL;
  IF unmatched_count > 0 THEN
    RAISE EXCEPTION 'settlement_batch %: % line(s) are unmatched at FINALIZE', b."id", unmatched_count;
  END IF;
  SELECT COUNT(*) INTO application_count FROM "settlement_application" WHERE "batchId" = b."id";
  IF line_count != application_count THEN
    RAISE EXCEPTION 'settlement_batch %: line count % != application count % at FINALIZE', b."id", line_count, application_count;
  END IF;

  -- D/E/F — Application/Line same batch, payment equality, money equality
  -- (already immediate-trigger-enforced at insert time; re-verified here as
  -- the commit-time defense-in-depth the deferred gate exists to provide).
  SELECT COUNT(*) INTO mismatched_count
    FROM "settlement_application" a
    JOIN "settlement_line" l ON l."id" = a."lineId"
    WHERE a."batchId" = b."id"
      AND (a."batchId" IS DISTINCT FROM l."batchId"
        OR a."paymentId" IS DISTINCT FROM l."matchedPaymentId"
        OR a."amountMinor" IS DISTINCT FROM l."amountMinor"
        OR a."currencyCode" IS DISTINCT FROM l."currencyCode"
        OR a."currencyExponent" IS DISTINCT FROM l."currencyExponent");
  IF mismatched_count > 0 THEN
    RAISE EXCEPTION 'settlement_batch %: % application/line mismatch(es) at FINALIZE', b."id", mismatched_count;
  END IF;

  -- G/H/I — gross = sum(lines) = sum(applications) = net + fee.
  SELECT COALESCE(SUM("amountMinor"), 0) INTO line_total FROM "settlement_line" WHERE "batchId" = b."id";
  IF line_total != b."grossSettlementMinor" THEN
    RAISE EXCEPTION 'settlement_batch %: grossSettlementMinor % != SUM(line.amountMinor) %', b."id", b."grossSettlementMinor", line_total;
  END IF;
  SELECT COALESCE(SUM("amountMinor"), 0) INTO application_total FROM "settlement_application" WHERE "batchId" = b."id";
  IF application_total != b."grossSettlementMinor" THEN
    RAISE EXCEPTION 'settlement_batch %: grossSettlementMinor % != SUM(application.amountMinor) %', b."id", b."grossSettlementMinor", application_total;
  END IF;
  IF b."grossSettlementMinor" != b."netBankMinor" + b."providerFeeMinor" THEN
    RAISE EXCEPTION 'settlement_batch %: grossSettlementMinor % != netBankMinor % + providerFeeMinor %', b."id", b."grossSettlementMinor", b."netBankMinor", b."providerFeeMinor";
  END IF;

  -- J — journalEntryId present.
  IF b."journalEntryId" IS NULL THEN
    RAISE EXCEPTION 'settlement_batch %: journalEntryId is NULL at FINALIZE', b."id";
  END IF;

  -- K/L — the referenced JournalEntry belongs EXACTLY to this batch (reuses
  -- the existing journal_entry (tenantId,companyId,sourceKind,sourceId)
  -- unique authority — an unrelated/wrong-source journal fails this join),
  -- postingDate/currencyCode match, and it is sealed.
  SELECT * INTO je FROM "journal_entry"
    WHERE "id" = b."journalEntryId"
      AND "tenantId" = b."tenantId"
      AND "companyId" = b."companyId"
      AND "sourceKind" = 'SETTLEMENT_BATCH'
      AND "sourceId" = b."id"::text;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'settlement_batch %: journalEntryId % does not resolve to a JournalEntry whose own (tenantId,companyId,sourceKind,sourceId) identity is exactly this batch', b."id", b."journalEntryId";
  END IF;
  IF je."postingDate" != b."providerSettlementDate" THEN
    RAISE EXCEPTION 'settlement_batch %: journal postingDate % != providerSettlementDate %', b."id", je."postingDate", b."providerSettlementDate";
  END IF;
  IF je."currencyCode" != b."currencyCode" THEN
    RAISE EXCEPTION 'settlement_batch %: journal currencyCode % != batch currencyCode %', b."id", je."currencyCode", b."currencyCode";
  END IF;
  IF je."sealedAt" IS NULL THEN
    RAISE EXCEPTION 'settlement_batch %: journal % was left unsealed at commit', b."id", je."id";
  END IF;

  -- M — branch dimension: every settlement JournalLine carries this batch's
  -- own branchId, and no posTerminalId (settlement is not POS-shift
  -- activity).
  SELECT COUNT(*) INTO bad_branch_or_pos_count
    FROM "journal_line" WHERE "journalEntryId" = je."id"
      AND ("branchId" IS DISTINCT FROM b."branchId" OR "posTerminalId" IS NOT NULL);
  IF bad_branch_or_pos_count > 0 THEN
    RAISE EXCEPTION 'settlement_batch %: % journal line(s) do not carry branchId=% with posTerminalId NULL', b."id", bad_branch_or_pos_count, b."branchId";
  END IF;

  -- N — exact 3-account economic shape. Account identity (not a
  -- discriminator column) disambiguates the legs; zero-value legs are
  -- omitted entirely (journal_line_exactly_one_side forbids a 0/0 line), so
  -- COALESCE(...,0) stands in for "this leg was legitimately not created".
  SELECT "id" INTO bank_account_id FROM "account" WHERE "tenantId" = b."tenantId" AND "companyId" = b."companyId" AND "key" = 'ASSET.BANK';
  SELECT "id" INTO fee_account_id FROM "account" WHERE "tenantId" = b."tenantId" AND "companyId" = b."companyId" AND "key" = 'EXPENSE.PAYMENT_PROCESSING_FEE';
  SELECT "id" INTO clearing_account_id FROM "account" WHERE "tenantId" = b."tenantId" AND "companyId" = b."companyId" AND "key" = 'ASSET.PAYMENT_CLEARING';
  IF bank_account_id IS NULL OR fee_account_id IS NULL OR clearing_account_id IS NULL THEN
    RAISE EXCEPTION 'settlement_batch %: company % is missing one of ASSET.BANK / EXPENSE.PAYMENT_PROCESSING_FEE / ASSET.PAYMENT_CLEARING', b."id", b."companyId";
  END IF;

  SELECT COALESCE(SUM("debitMinor"), 0), COALESCE(SUM("creditMinor"), 0) INTO bank_debit, bank_credit
    FROM "journal_line" WHERE "journalEntryId" = je."id" AND "accountId" = bank_account_id;
  SELECT COALESCE(SUM("debitMinor"), 0), COALESCE(SUM("creditMinor"), 0) INTO fee_debit, fee_credit
    FROM "journal_line" WHERE "journalEntryId" = je."id" AND "accountId" = fee_account_id;
  SELECT COALESCE(SUM("debitMinor"), 0), COALESCE(SUM("creditMinor"), 0) INTO clearing_debit, clearing_credit
    FROM "journal_line" WHERE "journalEntryId" = je."id" AND "accountId" = clearing_account_id;
  SELECT COUNT(*) INTO other_account_count
    FROM "journal_line" WHERE "journalEntryId" = je."id"
      AND "accountId" NOT IN (bank_account_id, fee_account_id, clearing_account_id);

  IF other_account_count > 0 THEN
    RAISE EXCEPTION 'settlement_batch %: journal % has % line(s) on an account other than Bank/Fee/Clearing', b."id", je."id", other_account_count;
  END IF;
  IF bank_debit != b."netBankMinor" THEN
    RAISE EXCEPTION 'settlement_batch %: journal Bank debit % != netBankMinor %', b."id", bank_debit, b."netBankMinor";
  END IF;
  IF fee_debit != b."providerFeeMinor" THEN
    RAISE EXCEPTION 'settlement_batch %: journal Fee debit % != providerFeeMinor %', b."id", fee_debit, b."providerFeeMinor";
  END IF;
  IF clearing_credit != b."grossSettlementMinor" THEN
    RAISE EXCEPTION 'settlement_batch %: journal Clearing credit % != grossSettlementMinor %', b."id", clearing_credit, b."grossSettlementMinor";
  END IF;
  IF bank_credit != 0 OR fee_credit != 0 OR clearing_debit != 0 THEN
    RAISE EXCEPTION 'settlement_batch %: journal % uses the wrong debit/credit direction on a settlement account', b."id", je."id";
  END IF;

  expected_line_count := 1
    + (CASE WHEN b."netBankMinor" > 0 THEN 1 ELSE 0 END)
    + (CASE WHEN b."providerFeeMinor" > 0 THEN 1 ELSE 0 END);
  SELECT COUNT(*) INTO je_line_count FROM "journal_line" WHERE "journalEntryId" = je."id";
  IF je_line_count != expected_line_count THEN
    RAISE EXCEPTION 'settlement_batch %: journal % has % line(s), expected % (1 + net>0 + fee>0)', b."id", je."id", je_line_count, expected_line_count;
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER trg_check_settlement_batch_finalized_complete
  AFTER INSERT OR UPDATE OF "state" ON "settlement_batch"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW."state" = 'FINALIZED')
  EXECUTE FUNCTION fn_check_settlement_batch_finalized_complete();

-- ══════════════════════ grants for the DB roles ═════════════════════════════
GRANT ALL ON "settlement_batch", "settlement_line", "settlement_application" TO flower_migrate;
GRANT SELECT, INSERT, UPDATE, DELETE ON "settlement_batch", "settlement_line", "settlement_application" TO flower_platform;
GRANT SELECT, INSERT, UPDATE, DELETE ON "settlement_batch", "settlement_line", "settlement_application" TO flower_app;

-- ══════════════════════ Row-Level Security (CLAUDE.md rule 7) ═══════════════
ALTER TABLE "settlement_batch" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "settlement_batch" FORCE ROW LEVEL SECURITY;
CREATE POLICY "settlement_batch_tenant_isolation" ON "settlement_batch"
  USING ("tenantId" = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "settlement_line" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "settlement_line" FORCE ROW LEVEL SECURITY;
CREATE POLICY "settlement_line_tenant_isolation" ON "settlement_line"
  USING ("tenantId" = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "settlement_application" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "settlement_application" FORCE ROW LEVEL SECURITY;
CREATE POLICY "settlement_application_tenant_isolation" ON "settlement_application"
  USING ("tenantId" = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- ══════════════════════ EXPENSE.PAYMENT_PROCESSING_FEE reference account ════
-- Additive system account (`packages/db/src/accounting-reference-data.ts`).
-- '5100' continues the EXPENSE category's own numbering (only prior EXPENSE
-- entry is '5000'). Exact backfill precedent as `EQUITY.OPENING_BALANCE`
-- (20260928130000_receivables_opening_balance_account): `flower_migrate`
-- OWNS `account` but is NOBYPASSRLS, and `account` is FORCE RLS, so even the
-- owner is filtered without the toggle. Idempotent + rerunnable —
-- `ON CONFLICT ("tenantId", "companyId", "key") DO NOTHING` can never create
-- a duplicate row. New-company provisioning already picks this key up for
-- free (unchanged code, maps ACCOUNTING_REFERENCE_ACCOUNTS verbatim). NO
-- journal is posted anywhere in this migration — seeding the account only.
ALTER TABLE "account" NO FORCE ROW LEVEL SECURITY;

INSERT INTO "account" ("id", "tenantId", "companyId", "key", "category", "displayCode", "displayName", "updatedAt")
SELECT uuidv7(), c."tenantId", c."id", 'EXPENSE.PAYMENT_PROCESSING_FEE', 'EXPENSE', '5100', 'Payment Processing Fee', now()
  FROM "company" c
ON CONFLICT ("tenantId", "companyId", "key") DO NOTHING;

ALTER TABLE "account" FORCE ROW LEVEL SECURITY;
