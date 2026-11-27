-- DRAFT A — NOT APPLIED, NOT IN packages/db/prisma/migrations. A PROPOSAL for owner approval (decision sheet C-3 / C-4).
-- Schema hardening of the drawer ledger: ONE nullable column (the reason CODE) and ONE sign CHECK. No data rewrite, no table, no index,
-- no policy / privilege change. `cash_movement` is append-only (its trigger forbids UPDATE / DELETE) — this migration needs neither.
-- Existing rows: only OPENING_FLOAT rows can exist today (E-5 is not wired, cash in/out has no route), and OPENING_FLOAT is unconstrained by the
-- sign CHECK below (the S1 float CHECK already says amountMinor >= 0), so the new constraints validate against every existing row.
-- Rollback: ALTER TABLE "cash_movement" DROP CONSTRAINT "cash_movement_sign_chk", DROP CONSTRAINT "cash_movement_reason_code_shape_chk",
--           DROP COLUMN "reasonCode";   (safe while no reason code has been written; afterwards the column is evidence — keep it)

ALTER TABLE "cash_movement"
  ADD COLUMN "reasonCode" TEXT;

ALTER TABLE "cash_movement"
  -- a reason is a short closed CODE (never free text); the allowed LIST is policy (application), the SHAPE is the database's
  ADD CONSTRAINT "cash_movement_reason_code_shape_chk"
    CHECK ("reasonCode" IS NULL OR "reasonCode" ~ '^[A-Z][A-Z0-9_]{1,31}$'),
  -- decision C-4 A: the sign of each type is enforced by the database (receipts positive, cash leaving negative)
  ADD CONSTRAINT "cash_movement_sign_chk"
    CHECK (CASE "type"
             WHEN 'CASH_SALE'         THEN "amountMinor" > 0
             WHEN 'CUSTOMER_PAYMENT'  THEN "amountMinor" > 0
             WHEN 'CASH_IN'           THEN "amountMinor" > 0
             WHEN 'CASH_REFUND'       THEN "amountMinor" < 0
             WHEN 'CASH_OUT'          THEN "amountMinor" < 0
             WHEN 'SAFE_DROP'         THEN "amountMinor" < 0
             WHEN 'EXPENSE'           THEN "amountMinor" < 0
             WHEN 'REGISTER_TRANSFER' THEN "amountMinor" <> 0
             WHEN 'ADJUSTMENT'        THEN "amountMinor" <> 0
             ELSE true            -- OPENING_FLOAT (own CHECK: >= 0) and CLOSING (informational) carry no sign rule here
           END);

-- OPTIONAL (E5-O8): one movement per source event across TYPES (the application already enforces it under an advisory lock):
--   CREATE UNIQUE INDEX "cash_movement_source_any_type_key" ON "cash_movement" ("tenantId", "sourceKind", "sourceId");
-- NOT part of this draft: it needs its own approval and is a write-cost trade-off on a table sized for very large volumes.
