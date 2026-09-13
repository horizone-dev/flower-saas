-- Phase 3b task 3b.1 — Chart of Accounts + Posting Engine foundation +
-- Accounting Periods. docs/phase-3/PHASE-3B-PLAN.md §C.1/§J. Additive,
-- forward-only. Four new tables — no Order / Invoice / Payment / AR / Advance /
-- Settlement / Cancellation / Refund / CreditNote / Inventory / Purchase /
-- COGS / BOM / Z-Report table (explicit non-scope, owner-frozen).
--
--   * `Company.accountingTimezone` / `Country.defaultTimezone` — additive
--     nullable columns. `Country.defaultTimezone` is provisioning-default
--     reference data ONLY, read once at company-provisioning time; it is never
--     re-read/re-applied to an existing Company. `Company.accountingTimezone`
--     is the SOLE financial-posting-authority timezone — nullable at rollout
--     (fails closed, ACCOUNTING_TIMEZONE_NOT_CONFIGURED, until explicitly set),
--     never Branch/Country/POS/client timezone.
--   * `pos_terminal` gets one additive composite unique
--     `(tenantId, companyId, branchId, id)` — an FK target only, so a
--     `journal_line` POS-attribution dimension can be structurally pinned to
--     the same tenant + company + branch (never an isolation axis).
--   * `account` / `accounting_period` / `journal_entry` / `journal_line` — one
--     GL per Company (ZF-3); Branch / POS terminal are journal-line
--     DIMENSIONS, never separate ledgers or isolation axes. RLS ENABLE +
--     FORCE + tenant policy, identical shape to every Phase 3a table.
--   * `btree_gist` — for the accounting-period non-overlap exclusion
--     constraint. `CREATE EXTENSION IF NOT EXISTS` is idempotent; on a managed
--     platform where the migration role cannot create an extension a DBA
--     pre-creates it and this line no-ops (identical convention to `pg_trgm`
--     in `20260906130000_catalog_core`). Verified installable in the
--     Testcontainers migration path. `btree_gist` is a trusted extension in
--     Postgres 13+ (ordinary CREATE privilege, no superuser needed) — same
--     privilege bar as the already-proven `pg_trgm`. No universal
--     managed-provider availability is claimed.
--   * Sealed-journal DB backstop (owner-frozen design, this session) — closes
--     the "line inserted into an already-posted journal" hole. `journal_entry`
--     carries an internal-only `sealedAt` marker (NOT a business-facing
--     lifecycle — externally a Journal either posts successfully or does not
--     exist). Five trigger objects, proven against scenarios A-L:
--       A. zero lines, commit                          -> REJECT (trigger 3)
--       B. one line, commit                             -> REJECT (trigger 3)
--       C. 2+ unbalanced lines                           -> REJECT (trigger 3)
--       D. balanced lines, total zero                    -> REJECT (trigger 3)
--       E. balanced 2+ lines + seal                       -> COMMIT
--       F. unsealed journal left at transaction end       -> REJECT (trigger 3)
--       G. INSERT line into an already-sealed committed
--          journal, in a NEW transaction                  -> REJECT (trigger 4)
--       H. UPDATE an existing posted line                 -> REJECT (trigger 5)
--       I. DELETE an existing posted line                 -> REJECT (trigger 5)
--       J. UPDATE an already-sealed journal_entry          -> REJECT (trigger 1)
--       K. DELETE a journal_entry (sealed or not)          -> REJECT (trigger 2)
--       L. reversal = a new, independently-sealed entry    -> ALLOW
--     Trigger 3 is a `CONSTRAINT TRIGGER ... AFTER INSERT ... DEFERRABLE
--     INITIALLY DEFERRED`, fired once per row event but re-SELECTing the
--     row's CURRENT state at commit time (never trusting the insert-time
--     `NEW` snapshot) — this is what closes the zero-line/unsealed-at-commit
--     hole: any transaction that leaves a row unsealed or unbalanced at
--     commit is aborted in its entirety, including the `journal_entry INSERT`
--     itself, so no other transaction ever observes a bad row.
--   * Structural (not merely RLS) tenant/company integrity — `journal_line`
--     carries composite FKs to `account`, `journal_entry`, `branch` and
--     `pos_terminal`, ALL keyed through `(tenantId, companyId, ...)` (and
--     additionally `branchId` for the POS FK) — a line cannot reference a
--     row from a different tenant/company even under an application bug; RLS
--     remains defense-in-depth, not the primary mechanism.
--   * `journal_line` carries NO `currencyCode`/`currencyExponent` — every
--     line inherits its parent `journal_entry.currencyCode` (single currency
--     per journal, no FX, no drift-by-construction — no field exists to
--     diverge).
--   * `account` carries NO status/lifecycle column in V1 — the 14 frozen
--     system keys are non-disableable by construction (no disable capability
--     exists); only `displayCode`/`displayName` are owner-editable.

-- ── btree_gist ──────────────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ── AlterTable — Company.accountingTimezone / Country.defaultTimezone ───────
ALTER TABLE "company" ADD COLUMN "accountingTimezone" TEXT;
ALTER TABLE "country" ADD COLUMN "defaultTimezone" TEXT;

-- ── AlterTable — pos_terminal additive composite unique (FK target only) ────
ALTER TABLE "pos_terminal"
  ADD CONSTRAINT "pos_terminal_tenantId_companyId_branchId_id_key"
  UNIQUE ("tenantId", "companyId", "branchId", "id");

-- ── CreateTable — account ────────────────────────────────────────────────────
CREATE TABLE "account" (
    "id"          UUID NOT NULL DEFAULT uuidv7(),
    "tenantId"    UUID NOT NULL,
    "companyId"   UUID NOT NULL,
    "key"         TEXT NOT NULL,
    "category"    TEXT NOT NULL,
    "displayCode" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "createdAt"   TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "account_pkey" PRIMARY KEY ("id")
);

-- ── CreateTable — accounting_period ─────────────────────────────────────────
CREATE TABLE "accounting_period" (
    "id"             UUID NOT NULL DEFAULT uuidv7(),
    "tenantId"       UUID NOT NULL,
    "companyId"      UUID NOT NULL,
    "startDate"      DATE NOT NULL,
    "endDate"        DATE NOT NULL,
    "status"         TEXT NOT NULL DEFAULT 'OPEN',
    "closedAt"       TIMESTAMPTZ(6),
    "closedByUserId" UUID,
    "version"        INTEGER NOT NULL DEFAULT 1,
    "createdAt"      TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"      TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "accounting_period_pkey" PRIMARY KEY ("id")
);

-- ── CreateTable — journal_entry ──────────────────────────────────────────────
CREATE TABLE "journal_entry" (
    "id"                       UUID NOT NULL DEFAULT uuidv7(),
    "tenantId"                 UUID NOT NULL,
    "companyId"                UUID NOT NULL,
    "accountingPeriodId"       UUID NOT NULL,
    "postingDate"              DATE NOT NULL,
    "sourceKind"               TEXT NOT NULL,
    "sourceId"                 TEXT NOT NULL,
    "currencyCode"             TEXT NOT NULL,
    "description"              TEXT,
    "reversalOfJournalEntryId" UUID,
    "postingFingerprint"       TEXT NOT NULL,
    "sealedAt"                 TIMESTAMPTZ(6),
    "createdByUserId"          UUID,
    "createdAt"                TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "journal_entry_pkey" PRIMARY KEY ("id")
);

-- ── CreateTable — journal_line ───────────────────────────────────────────────
CREATE TABLE "journal_line" (
    "id"             UUID NOT NULL DEFAULT uuidv7(),
    "tenantId"       UUID NOT NULL,
    "companyId"      UUID NOT NULL,
    "journalEntryId" UUID NOT NULL,
    "accountId"      UUID NOT NULL,
    "branchId"       UUID,
    "posTerminalId"  UUID,
    "debitMinor"     BIGINT NOT NULL DEFAULT 0,
    "creditMinor"    BIGINT NOT NULL DEFAULT 0,
    "description"    TEXT,
    "createdAt"      TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "journal_line_pkey" PRIMARY KEY ("id")
);

-- ── CreateIndex ───────────────────────────────────────────────────────────────
CREATE UNIQUE INDEX "account_tenantId_companyId_id_key" ON "account"("tenantId", "companyId", "id");
CREATE UNIQUE INDEX "account_tenantId_companyId_key_key" ON "account"("tenantId", "companyId", "key");
CREATE UNIQUE INDEX "account_tenantId_companyId_displayCode_key" ON "account"("tenantId", "companyId", "displayCode");
CREATE INDEX "account_tenantId_companyId_idx" ON "account"("tenantId", "companyId");

CREATE INDEX "accounting_period_tenantId_companyId_startDate_endDate_idx" ON "accounting_period"("tenantId", "companyId", "startDate", "endDate");

CREATE UNIQUE INDEX "journal_entry_tenantId_companyId_id_key" ON "journal_entry"("tenantId", "companyId", "id");
CREATE UNIQUE INDEX "journal_entry_tenantId_companyId_sourceKind_sourceId_key" ON "journal_entry"("tenantId", "companyId", "sourceKind", "sourceId");
CREATE UNIQUE INDEX "journal_entry_reversalOfJournalEntryId_key" ON "journal_entry"("reversalOfJournalEntryId");
CREATE INDEX "journal_entry_tenantId_companyId_postingDate_idx" ON "journal_entry"("tenantId", "companyId", "postingDate");

CREATE INDEX "journal_line_journalEntryId_idx" ON "journal_line"("journalEntryId");
CREATE INDEX "journal_line_tenantId_companyId_idx" ON "journal_line"("tenantId", "companyId");

-- ── AddForeignKey — plain FKs (tenant / company / id-only references) ───────
ALTER TABLE "account"
  ADD CONSTRAINT "account_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenant"("id") ON UPDATE CASCADE ON DELETE CASCADE,
  ADD CONSTRAINT "account_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "company"("id") ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE "accounting_period"
  ADD CONSTRAINT "accounting_period_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenant"("id") ON UPDATE CASCADE ON DELETE CASCADE,
  ADD CONSTRAINT "accounting_period_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "company"("id") ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE "journal_entry"
  ADD CONSTRAINT "journal_entry_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenant"("id") ON UPDATE CASCADE ON DELETE CASCADE,
  ADD CONSTRAINT "journal_entry_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "company"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  ADD CONSTRAINT "journal_entry_accountingPeriodId_fkey" FOREIGN KEY ("accountingPeriodId") REFERENCES "accounting_period"("id") ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE "journal_line"
  ADD CONSTRAINT "journal_line_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenant"("id") ON UPDATE CASCADE ON DELETE CASCADE,
  ADD CONSTRAINT "journal_line_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "company"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  ADD CONSTRAINT "journal_line_journalEntryId_fkey" FOREIGN KEY ("journalEntryId") REFERENCES "journal_entry"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  ADD CONSTRAINT "journal_line_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "account"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  ADD CONSTRAINT "journal_line_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branch"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  ADD CONSTRAINT "journal_line_posTerminalId_fkey" FOREIGN KEY ("posTerminalId") REFERENCES "pos_terminal"("id") ON UPDATE CASCADE ON DELETE RESTRICT;

-- ── AddForeignKey — composite tenant/company-safe FKs (structural integrity,
--    Task 3b.1 review §E/§F/§G/§O) — a line/reversal cannot reference a row
--    from a different tenant/company (or, for POS, a different branch) even
--    under an application bug. RLS remains defense-in-depth, not primary. ────
ALTER TABLE "journal_line"
  ADD CONSTRAINT "journal_line_account_tenant_company_fkey"
    FOREIGN KEY ("tenantId", "companyId", "accountId")
    REFERENCES "account"("tenantId", "companyId", "id")
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  ADD CONSTRAINT "journal_line_journal_entry_tenant_company_fkey"
    FOREIGN KEY ("tenantId", "companyId", "journalEntryId")
    REFERENCES "journal_entry"("tenantId", "companyId", "id")
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  ADD CONSTRAINT "journal_line_branch_tenant_company_fkey"
    FOREIGN KEY ("tenantId", "companyId", "branchId")
    REFERENCES "branch"("tenantId", "companyId", "id")
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  ADD CONSTRAINT "journal_line_pos_tenant_company_branch_fkey"
    FOREIGN KEY ("tenantId", "companyId", "branchId", "posTerminalId")
    REFERENCES "pos_terminal"("tenantId", "companyId", "branchId", "id")
    ON UPDATE NO ACTION ON DELETE NO ACTION;

-- reversal reference — same tenant/company as the original (§O). Included
-- even though `reversalOfJournalEntryId` also has a nullable-unique index
-- above (at most one full reversal per original entry).
ALTER TABLE "journal_entry"
  ADD CONSTRAINT "journal_entry_reversal_tenant_company_fkey"
    FOREIGN KEY ("tenantId", "companyId", "reversalOfJournalEntryId")
    REFERENCES "journal_entry"("tenantId", "companyId", "id")
    ON UPDATE NO ACTION ON DELETE NO ACTION;

-- ── CHECK constraints ─────────────────────────────────────────────────────────
ALTER TABLE "accounting_period"
  ADD CONSTRAINT "accounting_period_date_range_check" CHECK ("startDate" <= "endDate");

ALTER TABLE "journal_entry"
  ADD CONSTRAINT "journal_entry_no_self_reversal" CHECK ("reversalOfJournalEntryId" IS NULL OR "reversalOfJournalEntryId" != "id");

ALTER TABLE "journal_line"
  ADD CONSTRAINT "journal_line_debit_credit_nonneg" CHECK ("debitMinor" >= 0 AND "creditMinor" >= 0),
  ADD CONSTRAINT "journal_line_exactly_one_side" CHECK ((("debitMinor" > 0)::int + ("creditMinor" > 0)::int) = 1),
  ADD CONSTRAINT "journal_line_pos_requires_branch" CHECK ("posTerminalId" IS NULL OR "branchId" IS NOT NULL);

-- ── Exclusion constraint — accounting-period non-overlap (Task 3b.1 review
--    §5/§7). `companyId` alone is already sufficient (`company.id` is a plain
--    global UUID PK with a required `tenantId` FK — a company_id value can
--    never belong to two tenants), but `tenantId` is included anyway for
--    auditability/reader-clarity — non-load-bearing, not a correctness
--    requirement. Race-safe under concurrent period creation (GiST exclusion,
--    not an application-level check-then-insert). ──────────────────────────
ALTER TABLE "accounting_period"
  ADD CONSTRAINT "accounting_period_no_overlap"
  EXCLUDE USING gist (
    "tenantId" WITH =,
    "companyId" WITH =,
    daterange("startDate", "endDate", '[]') WITH &&
  );

-- ══════════════════════ sealed-journal DB backstop ══════════════════════════
-- See header comment for the full A-L proof table. `sealedAt` is an internal
-- implementation marker (schema.prisma doc comment) — NOT a business-facing
-- lifecycle; externally a Journal either posts successfully or does not exist.

-- Trigger 1 (scenario J) — the ONLY legal UPDATE on journal_entry is the
-- one-time unsealed -> sealed transition, and it may touch ONLY `sealedAt`.
-- Any other UPDATE — including any further UPDATE once already sealed — is
-- rejected outright.
CREATE FUNCTION fn_enforce_journal_entry_seal_transition() RETURNS trigger AS $$
BEGIN
  IF OLD."sealedAt" IS NULL AND NEW."sealedAt" IS NOT NULL
     AND OLD."id" = NEW."id"
     AND OLD."tenantId" = NEW."tenantId"
     AND OLD."companyId" = NEW."companyId"
     AND OLD."accountingPeriodId" = NEW."accountingPeriodId"
     AND OLD."postingDate" = NEW."postingDate"
     AND OLD."sourceKind" = NEW."sourceKind"
     AND OLD."sourceId" = NEW."sourceId"
     AND OLD."currencyCode" = NEW."currencyCode"
     AND OLD."description" IS NOT DISTINCT FROM NEW."description"
     AND OLD."reversalOfJournalEntryId" IS NOT DISTINCT FROM NEW."reversalOfJournalEntryId"
     AND OLD."postingFingerprint" = NEW."postingFingerprint"
     AND OLD."createdByUserId" IS NOT DISTINCT FROM NEW."createdByUserId"
     AND OLD."createdAt" = NEW."createdAt"
  THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'journal_entry is append-only: only the one-time unsealed -> sealed transition is permitted (id=%)', OLD."id";
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_enforce_journal_entry_seal_transition
  BEFORE UPDATE ON "journal_entry"
  FOR EACH ROW EXECUTE FUNCTION fn_enforce_journal_entry_seal_transition();

-- Trigger 2 (scenario K) — journal_entry is never deleted, sealed or not.
CREATE FUNCTION fn_enforce_journal_entry_no_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'journal_entry is append-only: DELETE is never permitted (id=%)', OLD."id";
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_enforce_journal_entry_no_delete
  BEFORE DELETE ON "journal_entry"
  FOR EACH ROW EXECUTE FUNCTION fn_enforce_journal_entry_no_delete();

-- Trigger 3 (scenarios A, B, C, D, E, F) — deferred to COMMIT, fired once per
-- INSERT row event. CRITICAL: re-SELECTs the row's CURRENT state by `NEW.id`
-- rather than trusting the insert-time `NEW.sealedAt` snapshot, because by
-- commit time the row may have since been sealed (the one legal UPDATE) and
-- its lines may have since been inserted — both of which happen strictly
-- AFTER this row's own INSERT event in the standard posting sequence. Firing
-- only on INSERT (not UPDATE) is sufficient: the deferred check always reads
-- the row's final state at commit regardless of how many UPDATEs occurred.
CREATE FUNCTION fn_check_journal_entry_sealed_and_balanced() RETURNS trigger AS $$
DECLARE
  current_sealed_at TIMESTAMPTZ;
  line_count BIGINT;
  debit_total NUMERIC;
  credit_total NUMERIC;
BEGIN
  SELECT "sealedAt" INTO current_sealed_at FROM "journal_entry" WHERE "id" = NEW."id";

  IF current_sealed_at IS NULL THEN
    RAISE EXCEPTION 'journal_entry % was left unsealed at commit — the posting transaction must seal every entry it creates', NEW."id";
  END IF;

  SELECT COUNT(*), COALESCE(SUM("debitMinor"), 0), COALESCE(SUM("creditMinor"), 0)
    INTO line_count, debit_total, credit_total
    FROM "journal_line" WHERE "journalEntryId" = NEW."id";

  IF line_count < 2 THEN
    RAISE EXCEPTION 'journal_entry % has % line(s) — a posted journal requires at least 2 lines', NEW."id", line_count;
  END IF;
  IF debit_total != credit_total THEN
    RAISE EXCEPTION 'journal_entry % is unbalanced: debit total % != credit total %', NEW."id", debit_total, credit_total;
  END IF;
  IF debit_total <= 0 THEN
    RAISE EXCEPTION 'journal_entry % has a zero (or negative) balanced total — not a valid posting', NEW."id";
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER trg_check_journal_entry_sealed_and_balanced
  AFTER INSERT ON "journal_entry"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION fn_check_journal_entry_sealed_and_balanced();

-- Trigger 4 (scenario G) — a line can only be inserted while its parent is
-- still unsealed (i.e. within the parent's own, still-open posting
-- transaction). Own-transaction MVCC visibility means this correctly allows
-- steps (a)-(b) of the posting sequence and rejects any later attempt (a new
-- transaction, after commit, always sees the already-sealed committed state).
CREATE FUNCTION fn_enforce_journal_line_insert_before_seal() RETURNS trigger AS $$
DECLARE
  parent_sealed_at TIMESTAMPTZ;
BEGIN
  SELECT "sealedAt" INTO parent_sealed_at FROM "journal_entry" WHERE "id" = NEW."journalEntryId";
  IF parent_sealed_at IS NOT NULL THEN
    RAISE EXCEPTION 'journal_entry % is already sealed — no further journal_line may be inserted', NEW."journalEntryId";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_enforce_journal_line_insert_before_seal
  BEFORE INSERT ON "journal_line"
  FOR EACH ROW EXECUTE FUNCTION fn_enforce_journal_line_insert_before_seal();

-- Trigger 5 (scenarios H, I) — journal_line is append-only: no UPDATE, no
-- DELETE, ever, ONCE INSERTED — closes the "line moved between entries" case
-- entirely rather than special-casing it (Task 3b.1 review §D).
CREATE FUNCTION fn_enforce_journal_line_append_only() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'journal_line is append-only: DELETE is never permitted (id=%)', OLD."id";
  ELSE
    RAISE EXCEPTION 'journal_line is append-only: UPDATE is never permitted (id=%)', OLD."id";
  END IF;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_enforce_journal_line_append_only
  BEFORE UPDATE OR DELETE ON "journal_line"
  FOR EACH ROW EXECUTE FUNCTION fn_enforce_journal_line_append_only();

-- ══════════════════════ grants for the DB roles ═════════════════════════════
GRANT ALL ON "account", "accounting_period", "journal_entry", "journal_line" TO flower_migrate;
GRANT SELECT, INSERT, UPDATE, DELETE ON "account", "accounting_period", "journal_entry", "journal_line" TO flower_platform;
-- full DML — tenant business data written via runScoped / flower_app; RLS
-- narrows every statement to the request tenant. The sealed-journal triggers
-- above apply regardless of role (including flower_app), so append-only /
-- balance / minimum-line invariants hold even against the ordinary
-- application connection, not merely a trusted internal caller. NO REVOKE.
GRANT SELECT, INSERT, UPDATE, DELETE ON "account", "accounting_period", "journal_entry", "journal_line" TO flower_app;

-- ══════════════════════ Row-Level Security (plan §C.11) ═════════════════════
ALTER TABLE "account" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "account" FORCE ROW LEVEL SECURITY;
CREATE POLICY "account_tenant_isolation" ON "account"
  USING ("tenantId" = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "accounting_period" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "accounting_period" FORCE ROW LEVEL SECURITY;
CREATE POLICY "accounting_period_tenant_isolation" ON "accounting_period"
  USING ("tenantId" = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "journal_entry" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "journal_entry" FORCE ROW LEVEL SECURITY;
CREATE POLICY "journal_entry_tenant_isolation" ON "journal_entry"
  USING ("tenantId" = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "journal_line" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "journal_line" FORCE ROW LEVEL SECURITY;
CREATE POLICY "journal_line_tenant_isolation" ON "journal_line"
  USING ("tenantId" = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = nullif(current_setting('app.tenant_id', true), '')::uuid);
