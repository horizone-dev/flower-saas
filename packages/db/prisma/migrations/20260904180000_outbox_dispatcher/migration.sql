-- Task 2.4 — PostgreSQL outbox dispatcher -> durable per-tenant Redis Stream.
-- Additive, forward-only.
--
--   * outbox +branchId/resourceVersion/actorSummary — optional ADR-0017 envelope
--     fields (branch_id, resource_version, actor_summary). None are ever set by
--     the current provisioning producer; all nullable, no behaviour change.
--   * outbox_tenant_seq (new, platform-global) — the durable per-tenant `seq`
--     counter (OI-P2-1): a database-backed row per tenant, incremented inside the
--     transaction that holds `pg_advisory_xact_lock` for that tenant (the
--     dispatcher leader). Chosen over a dynamic per-tenant PostgreSQL SEQUENCE
--     object — simpler to migrate, test and operate, and just as crash-safe /
--     gap-tolerant (a rolled-back UPDATE reverts the counter with the row lock,
--     so no value is ever lost or reused).
--   * a partial index to make the dispatcher's two read paths — "which tenants
--     have unstamped work" and "which stamped rows are ready to publish" —
--     index-only scans instead of table scans.

-- AlterTable (partitioned parent — ADD COLUMN propagates to every partition)
ALTER TABLE "outbox" ADD COLUMN     "branchId" UUID,
ADD COLUMN     "resourceVersion" BIGINT,
ADD COLUMN     "actorSummary" JSONB;

-- CreateTable
CREATE TABLE "outbox_tenant_seq" (
    "tenantId" UUID NOT NULL,
    "nextSeq" BIGINT NOT NULL DEFAULT 1,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outbox_tenant_seq_pkey" PRIMARY KEY ("tenantId")
);

-- CreateIndex — the seq-allocation read path: "does tenant T have unstamped,
-- eligible rows, oldest first". A partial index (Prisma cannot express this
-- declaratively — the schema comment on Outbox.seq documents it; hand-maintained
-- like `outbox_undispatched_idx` from task 2.1).
CREATE INDEX "outbox_unstamped_idx" ON "outbox" ("tenantId", "createdAt", "id")
  WHERE "seq" IS NULL AND "dispatchedAt" IS NULL;

-- CreateIndex — the publish read path: "which already-stamped rows are ready to
-- XADD now", oldest first, across all tenants.
CREATE INDEX "outbox_ready_to_publish_idx" ON "outbox" ("availableAt")
  WHERE "seq" IS NOT NULL AND "dispatchedAt" IS NULL;

-- ─────────────────────────── grants for the DB roles ─────────────────────────
-- outbox_tenant_seq is dispatcher-internal bookkeeping, never touched from a
-- tenant request — flower_app gets nothing (stricter than the task 2.1 reference
-- tables, which are at least SELECT-readable). New tables inherit
-- SELECT,INSERT,UPDATE,DELETE for flower_app from the Phase 1
-- ALTER DEFAULT PRIVILEGES, so an explicit REVOKE is required (same pattern as
-- task 2.1). flower_platform's DML comes from the same Phase 1 default
-- privileges — no explicit GRANT needed here, only flower_migrate for symmetry
-- with the existing pattern.
GRANT ALL ON "outbox_tenant_seq" TO flower_migrate;
REVOKE ALL ON "outbox_tenant_seq" FROM flower_app;

-- No RLS on outbox_tenant_seq — platform-global, RLS-exempt (same posture as the
-- task 2.1 reference tables): only flower_platform (BYPASSRLS) ever reaches it.
