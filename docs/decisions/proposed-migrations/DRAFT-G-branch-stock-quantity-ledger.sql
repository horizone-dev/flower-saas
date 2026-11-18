-- DRAFT (NOT APPLIED — NOT in packages/db/prisma/migrations) — MVP inventory subset "G": BRANCH STOCK QUANTITY LEDGER.
--
-- WHAT: the smallest safe stock engine for a real flower shop — a per-(branch, variant) QUANTITY ledger with atomic deduction. NO valuation:
-- no unit cost, no inventory value, no COGS, no journal posting. See docs/mvp/INVENTORY-MVP-DESIGN.md.
--
-- NEEDS BEFORE IT CAN BE APPLIED (none of these is assumed approved):
--   1. owner + accountant: a quantity-only interim (no COGS / inventory-value GL postings) deviates from CLAUDE.md rules 20/25 (perpetual
--      weighted-average COGS; inventory<->GL atomicity). It must be APPROVED explicitly as a pilot-only interim, or the pilot waits for Phase 5.
--   2. owner: NO NEGATIVE STOCK (this draft enforces `quantityOnHand >= 0` in the database; "allow negative" would need a different CHECK).
--   3. a real migration name/timestamp, the Prisma models, the S0b permission baseline facts for the new keys, and the sale-path integration
--      (an approved change to the frozen complete-sale transaction — see the design doc §5).
--
-- DESIGN (the database is the last line of defence; the application is the authority):
--   * stock_movement  — APPEND-ONLY ledger. UNIQUE (tenant, branch, variant, type, sourceKind, sourceId) makes every operation idempotent:
--                       a retry inserts nothing (ON CONFLICT DO NOTHING) so the balance is never touched twice.
--   * branch_stock_balance — a DERIVED projection, maintained ONLY by the AFTER INSERT trigger on stock_movement (the application role has
--                       SELECT only). The trigger's UPDATE takes the balance row lock, and the CHECK (>= 0) is evaluated against the locked,
--                       current value — "re-check availability inside the lock" with no application race.
--   * A variant is stock-TRACKED iff it has a balance row (created by an OPENING movement). Untracked variants keep the availability flag only.
--   * RLS: tenant + branch isolation exactly like branch_variant_availability (FORCE RLS; flower_app is NOBYPASSRLS).

CREATE TABLE "stock_movement" (
  "id"            UUID          NOT NULL DEFAULT uuidv7(),
  "tenantId"      UUID          NOT NULL,
  "companyId"     UUID          NOT NULL,
  "branchId"      UUID          NOT NULL,
  "variantId"     UUID          NOT NULL,
  "movementType"  TEXT          NOT NULL,
  "quantityDelta" NUMERIC(18,4) NOT NULL,
  "sourceKind"    TEXT          NOT NULL,
  "sourceId"      TEXT          NOT NULL,
  "reason"        TEXT,
  "createdByUserId" UUID,
  "createdAt"     TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "stock_movement_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "stock_movement_type_chk" CHECK ("movementType" IN
    ('OPENING','RECEIPT','SALE','SALE_REVERSAL','ADJUSTMENT_IN','ADJUSTMENT_OUT')),
  -- the sign is a function of the type: a SALE can only remove stock, a reversal / receipt can only add it
  CONSTRAINT "stock_movement_sign_chk" CHECK (
       ("movementType" IN ('OPENING')                                   AND "quantityDelta" >= 0)
    OR ("movementType" IN ('RECEIPT','SALE_REVERSAL','ADJUSTMENT_IN')   AND "quantityDelta" > 0)
    OR ("movementType" IN ('SALE','ADJUSTMENT_OUT')                     AND "quantityDelta" < 0)),
  CONSTRAINT "stock_movement_reason_chk" CHECK (
    "movementType" NOT IN ('ADJUSTMENT_IN','ADJUSTMENT_OUT') OR length(btrim(coalesce("reason", ''))) > 0),
  CONSTRAINT "stock_movement_source_nonempty_chk" CHECK (length(btrim("sourceKind")) > 0 AND length(btrim("sourceId")) > 0),
  CONSTRAINT "stock_movement_tenant_fk"  FOREIGN KEY ("tenantId")  REFERENCES "tenant"("id")  ON DELETE RESTRICT,
  CONSTRAINT "stock_movement_company_fk" FOREIGN KEY ("tenantId", "companyId") REFERENCES "company"("tenantId", "id") ON DELETE RESTRICT,
  CONSTRAINT "stock_movement_branch_fk"  FOREIGN KEY ("tenantId", "companyId", "branchId") REFERENCES "branch"("tenantId", "companyId", "id") ON DELETE RESTRICT,
  CONSTRAINT "stock_movement_variant_fk" FOREIGN KEY ("tenantId", "variantId") REFERENCES "variant"("tenantId", "id") ON DELETE RESTRICT
);
-- the idempotency key of every stock operation
CREATE UNIQUE INDEX "stock_movement_idempotency_uq"
  ON "stock_movement" ("tenantId", "branchId", "variantId", "movementType", "sourceKind", "sourceId");
CREATE INDEX "stock_movement_branch_variant_idx" ON "stock_movement" ("tenantId", "branchId", "variantId", "createdAt");

CREATE TABLE "branch_stock_balance" (
  "tenantId"       UUID          NOT NULL,
  "companyId"      UUID          NOT NULL,
  "branchId"       UUID          NOT NULL,
  "variantId"      UUID          NOT NULL,
  "quantityOnHand" NUMERIC(18,4) NOT NULL,
  "version"        BIGINT        NOT NULL DEFAULT 1,
  "updatedAt"      TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "branch_stock_balance_pkey" PRIMARY KEY ("tenantId", "branchId", "variantId"),
  -- NO NEGATIVE STOCK (owner decision pending; this is the safe default). A violating UPDATE aborts the whole sale transaction.
  CONSTRAINT "branch_stock_balance_non_negative_chk" CHECK ("quantityOnHand" >= 0),
  CONSTRAINT "branch_stock_balance_branch_fk"  FOREIGN KEY ("tenantId", "companyId", "branchId") REFERENCES "branch"("tenantId", "companyId", "id") ON DELETE RESTRICT,
  CONSTRAINT "branch_stock_balance_variant_fk" FOREIGN KEY ("tenantId", "variantId") REFERENCES "variant"("tenantId", "id") ON DELETE RESTRICT
);

-- ── movements are append-only ─────────────────────────────────────────────
CREATE FUNCTION fn_stock_movement_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'stock_movement is append-only: % is never permitted (id=%)', TG_OP, OLD."id";
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_stock_movement_append_only
  BEFORE UPDATE OR DELETE ON "stock_movement"
  FOR EACH ROW EXECUTE FUNCTION fn_stock_movement_append_only();

-- ── the balance is a projection of the ledger: maintained ONLY here ─────────
-- SECURITY DEFINER (owner flower_migrate, FORCE-RLS still applies: the caller's app.tenant_id / app.branch_id session settings are in force,
-- so the trigger can only ever touch rows of the caller's own tenant/branch).
CREATE FUNCTION fn_stock_movement_apply() RETURNS trigger AS $$
DECLARE
  n INTEGER;
BEGIN
  IF NEW."movementType" = 'OPENING' THEN
    INSERT INTO "branch_stock_balance" ("tenantId","companyId","branchId","variantId","quantityOnHand")
    VALUES (NEW."tenantId", NEW."companyId", NEW."branchId", NEW."variantId", NEW."quantityDelta");
    RETURN NEW;  -- a second OPENING for the same (branch, variant) hits the balance primary key and aborts: opening stock is set once
  END IF;
  IF NEW."movementType" = 'SALE_REVERSAL' THEN
    -- a reversal must undo EXACTLY one earlier SALE of the same source (full cancel only; partial returns are a later, approved design)
    PERFORM 1 FROM "stock_movement" s
     WHERE s."tenantId" = NEW."tenantId" AND s."branchId" = NEW."branchId" AND s."variantId" = NEW."variantId"
       AND s."movementType" = 'SALE' AND s."sourceKind" = NEW."sourceKind" AND s."sourceId" = NEW."sourceId"
       AND s."quantityDelta" = -NEW."quantityDelta";
    IF NOT FOUND THEN
      RAISE EXCEPTION 'STOCK_REVERSAL_WITHOUT_SALE: no matching sale of % for source %/%', NEW."variantId", NEW."sourceKind", NEW."sourceId"
        USING ERRCODE = 'P0001';
    END IF;
  END IF;
  UPDATE "branch_stock_balance"
     SET "quantityOnHand" = "quantityOnHand" + NEW."quantityDelta", "version" = "version" + 1, "updatedAt" = now()
   WHERE "tenantId" = NEW."tenantId" AND "branchId" = NEW."branchId" AND "variantId" = NEW."variantId";
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n = 0 THEN
    RAISE EXCEPTION 'STOCK_NOT_TRACKED: no opening stock for variant % in branch %', NEW."variantId", NEW."branchId"
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;
CREATE TRIGGER trg_stock_movement_apply
  AFTER INSERT ON "stock_movement"
  FOR EACH ROW EXECUTE FUNCTION fn_stock_movement_apply();

-- ── RLS: tenant + branch isolation (same shape as branch_variant_availability) ─
ALTER TABLE "stock_movement" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "stock_movement_tenant_branch_isolation" ON "stock_movement"
  USING ("tenantId" = nullif(current_setting('app.tenant_id', true), '')::uuid
     AND (nullif(current_setting('app.branch_id', true), '') IS NULL OR "branchId" = nullif(current_setting('app.branch_id', true), '')::uuid))
  WITH CHECK ("tenantId" = nullif(current_setting('app.tenant_id', true), '')::uuid
     AND (nullif(current_setting('app.branch_id', true), '') IS NULL OR "branchId" = nullif(current_setting('app.branch_id', true), '')::uuid));
ALTER TABLE "stock_movement" FORCE ROW LEVEL SECURITY;

ALTER TABLE "branch_stock_balance" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "branch_stock_balance_tenant_branch_isolation" ON "branch_stock_balance"
  USING ("tenantId" = nullif(current_setting('app.tenant_id', true), '')::uuid
     AND (nullif(current_setting('app.branch_id', true), '') IS NULL OR "branchId" = nullif(current_setting('app.branch_id', true), '')::uuid))
  WITH CHECK ("tenantId" = nullif(current_setting('app.tenant_id', true), '')::uuid
     AND (nullif(current_setting('app.branch_id', true), '') IS NULL OR "branchId" = nullif(current_setting('app.branch_id', true), '')::uuid));
ALTER TABLE "branch_stock_balance" FORCE ROW LEVEL SECURITY;

GRANT ALL ON "stock_movement", "branch_stock_balance" TO flower_migrate;
GRANT SELECT, INSERT ON "stock_movement" TO flower_app, flower_platform;       -- append-only for the application
GRANT SELECT ON "branch_stock_balance" TO flower_app, flower_platform;         -- the balance is written ONLY by the trigger

-- Default privileges (ALTER DEFAULT PRIVILEGES, Phase 1) hand flower_app / flower_platform full DML on every new table, so the narrowing
-- above must be an EXPLICIT REVOKE: the balance is written ONLY by the (definer) trigger, and the ledger is insert-only. (The append-only
-- trigger on stock_movement additionally blocks UPDATE / DELETE for any role.)
REVOKE INSERT, UPDATE, DELETE ON "branch_stock_balance" FROM flower_app, flower_platform;
REVOKE UPDATE, DELETE ON "stock_movement" FROM flower_app, flower_platform;
