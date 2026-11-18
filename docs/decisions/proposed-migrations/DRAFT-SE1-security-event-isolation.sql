-- DRAFT SE1 — security_event tenant isolation.  UNAPPLIED. NOT a real migration. NOT approved.
--
-- FINDING (measured on disposable PostgreSQL 17 through REAL flower_app logins — see
-- packages/db/test/phase4-security-event-isolation.integration.test.ts):
--   The view `security_event` (migration 20260904120000) has no `security_invoker` option, so PostgreSQL runs
--   its underlying-table access as the VIEW OWNER. `audit_log` and `login_security_event` are FORCE ROW LEVEL
--   SECURITY, which binds a NON-superuser owner — but a SUPERUSER owner bypasses RLS entirely. Where the view
--   is owned by a superuser (the test harness; infra/staging/docker-compose.staging.yml, whose `migrate`
--   service connects as `postgres`), the application role `flower_app` — which holds SELECT on the view through
--   the Phase 1 default privileges, contrary to the migration's own comment "the app role never does" — reads
--   EVERY tenant's security events, and the platform-scoped / pre-auth rows that have no tenant at all:
--     * with its tenant GUC set to its own tenant   (6 of 9 rows were foreign or tenant-less),
--     * with NO tenant GUC at all                    (all 9 rows; the same session reads 0 rows of the tables),
--     * through the real runScoped code path.
--   Where the view is owned by a non-superuser with NOBYPASSRLS (the posture the migration comments describe
--   for production: `flower_migrate`), FORCE RLS applies and the view is isolated. The exposure is the owner's
--   RLS bypass, not the view's SQL; it is read-only (the view is not auto-updatable).
--   No production code path reads the view as the application role (the only reader, audit-read.repository.ts,
--   runs on the platform client), so this is a defence-in-depth gap at the database boundary, not a live
--   application-level leak — but one SQL-capable defect in the application role would read every tenant.
--
-- THE FIX — two independent layers (each alone closes the measured leak; both together are the draft):
--   1. `security_invoker = true`: the view's underlying access is checked as the CALLER, so RLS applies to the
--      caller whoever owns the view. flower_platform (BYPASSRLS) still sees every tenant — the intended path.
--      This removes the dependence on who ran the migration.
--   2. The platform-only ACL the original comment promised: no PUBLIC, no flower_app; flower_platform holds
--      exactly SELECT (the view is not updatable, so its inherited DML grants were inert least-privilege debt).
--
-- NOT changed: the view definition (columns, LIKE list), every table, policy, trigger, and the platform read.
-- Requires PostgreSQL 15+ (`security_invoker`); every environment in this repository runs 17.
-- Not covered here (separate decision): whether staging migrations should stop running as a superuser.
--
-- HAZARD (measured, test R1h): a LATER `CREATE OR REPLACE VIEW "security_event"` WITHOUT a WITH clause silently
-- RESETS `security_invoker` (the ACL survives). The view has already been replaced twice
-- (20260906120000_catalog_capability_foundation, 20260906130000_catalog_core). Any future migration that replaces
-- it must restate `WITH (security_invoker = true)`; the structural pin for this package enforces it for every
-- migration that sorts after this one.
--
-- ACTIVATION COUPLING: promoting this as a real migration needs the frozen-baseline authorisation of its name +
-- sha256 (apps/api/src/verification/frozen-baseline.ts AUTHORIZED_ADDITIONS) and the "newest migration" pins,
-- exactly as for AL1; the frozen migration 20260904120000_security_event_view itself is NOT edited.

ALTER VIEW "security_event" SET (security_invoker = true);

REVOKE ALL ON "security_event" FROM PUBLIC, flower_app, flower_platform;
GRANT SELECT ON "security_event" TO flower_platform;
