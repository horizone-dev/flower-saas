-- Task 0.6 — RLS policies + the non-superuser application role.
-- Applied by the spike test as the DB superuser AFTER `prisma migrate deploy`.
-- Mirrors the production posture in docs/architecture/SECURITY.md and ADR-0004:
--   * app role is NOSUPERUSER + NOBYPASSRLS
--   * every tenant table has RLS + FORCE RLS
--   * policy keys off current_setting('app.tenant_id') via nullif(...,'') so an
--     UNSET or EMPTY GUC yields ZERO rows (fails closed), never a cross-tenant leak

-- --- application role ---
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'spike_app') THEN
    CREATE ROLE spike_app LOGIN PASSWORD 'spike_app' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO spike_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON spike_tenant, spike_row TO spike_app;
GRANT SELECT ON _prisma_migrations TO spike_app;

-- DB-side id defaults so the seed can INSERT ... RETURNING id (PG 17 built-in).
ALTER TABLE spike_tenant ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE spike_row ALTER COLUMN id SET DEFAULT gen_random_uuid();

-- --- RLS ---
ALTER TABLE spike_tenant ENABLE ROW LEVEL SECURITY;
ALTER TABLE spike_tenant FORCE ROW LEVEL SECURITY;
ALTER TABLE spike_row ENABLE ROW LEVEL SECURITY;
ALTER TABLE spike_row FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS spike_tenant_isolation ON spike_tenant;
CREATE POLICY spike_tenant_isolation ON spike_tenant
  USING (id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS spike_row_isolation ON spike_row;
CREATE POLICY spike_row_isolation ON spike_row
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
