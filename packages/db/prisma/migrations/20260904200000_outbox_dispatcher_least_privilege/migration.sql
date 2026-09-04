-- Task 2.4 remediation (owner review, 2026-09-04) — least-privilege DB role for
-- the outbox dispatcher.
--
-- The dispatcher previously ran as `flower_platform` (BYPASSRLS, full DML on
-- EVERY table — the same broad capability the platform-admin module uses for
-- cross-tenant provisioning/audit operations). That is far more than dispatch
-- needs: claiming eligible `outbox` rows, stamping `seq`, marking
-- dispatched/attempts/available_at/last_error, and incrementing the durable
-- per-tenant `outbox_tenant_seq` counter. A bug or compromise in the worker
-- process should not be able to read or write `user` / `credential` /
-- `session` / any tenant business table.
--
-- `flower_dispatcher` still needs BYPASSRLS — it must scan undispatched rows
-- across every tenant, and there is no single `app.tenant_id` to scope a
-- request to (this mirrors why `flower_platform` needs it too) — but its
-- *grants* are narrowed to exactly the two tables dispatch touches. BYPASSRLS
-- only matters for a table the role can otherwise reach; with no grant on any
-- other table, RLS bypass on this role has no broader blast radius than "sees
-- every tenant's outbox / outbox_tenant_seq rows" — which is the dispatcher's
-- whole job.

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'flower_dispatcher') THEN
    CREATE ROLE flower_dispatcher NOLOGIN NOSUPERUSER BYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO flower_dispatcher;

-- Defensive REVOKE first (this role never appears in the Phase 1
-- ALTER DEFAULT PRIVILEGES rules, so it should already have nothing — this
-- documents and enforces that invariant rather than relying on it silently).
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM flower_dispatcher;

-- outbox: claim + stamp + ack/back-off. No INSERT (the dispatcher never
-- creates outbox rows — only apps/api's OutboxWriter does, as flower_app /
-- flower_platform) and no DELETE (rows are never removed by the dispatcher).
GRANT SELECT, UPDATE ON "outbox" TO flower_dispatcher;

-- outbox_tenant_seq: the durable per-tenant counter — read, upsert (INSERT ...
-- ON CONFLICT DO UPDATE), never DELETE.
GRANT SELECT, INSERT, UPDATE ON "outbox_tenant_seq" TO flower_dispatcher;

-- Deliberately NOT added to the Phase 1 `ALTER DEFAULT PRIVILEGES` rules —
-- flower_dispatcher must never automatically inherit access to a future new
-- table. Every grant it ever gets must be an explicit, reviewed line here.
