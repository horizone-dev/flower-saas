-- DRAFT AL1 — NOT APPLIED, NOT IN packages/db/prisma/migrations. A SECURITY-HARDENING PROPOSAL (audit_log immutability). Additive: NO table, column, index, policy or view is changed; the RLS policy,
-- the `security_event` view and the way every module INSERTs into `audit_log` are untouched.
--
-- THE VULNERABILITY (measured on a disposable database, Phase 4.7 rehearsal)
--   The Phase 1 default privileges grant SELECT, INSERT, UPDATE, DELETE on EVERY new table to flower_app and flower_platform, and nothing protects `audit_log` (no trigger, no REVOKE): an
--   application-role transaction can UPDATE or DELETE its own tenant's audit rows. A platform-path (BYPASSRLS) transaction can do so for EVERY tenant's rows. The partition `audit_log_default` is its
--   own table with its own ACL, so even a REVOKE on the parent alone would leave `UPDATE audit_log_default …` open.
--
-- WHAT THE IMPACT ASSESSMENT FOUND (no legitimate workflow needs UPDATE, DELETE or TRUNCATE)
--   writers : AuditWriter.record / emit (`tx.auditLog.create`), provisioning (`createMany`), the platform-operator bootstrap — INSERT only. readers: platform audit-read (platform path), a raw SELECT in the
--   Z sales-facts read, the `security_event` view (owner-privileged read). There is no retention / purge job, no FK to audit_log, nothing cascades into it, no code path updates `prevHash` / `entryHash`.
--
-- THE SAFEGUARDS (defence in depth — each layer is proven separately on a disposable database)
--   1. PRIVILEGES: everything is revoked from PUBLIC, flower_app and flower_platform on the parent AND on every existing partition, then exactly SELECT + INSERT are granted back. The DDL role
--      flower_migrate loses UPDATE / DELETE / TRUNCATE too (it needs none to change a schema).
--   2. APPEND-ONLY ROW GUARD: a BEFORE UPDATE OR DELETE row trigger on the parent (PostgreSQL clones it onto every partition, existing and FUTURE) refuses the operation for EVERY role, including the
--      table owner and a superuser — a privilege can be re-granted, a guard that fires regardless cannot be argued with.
--   3. TRUNCATE GUARD: a row trigger cannot see TRUNCATE and a statement trigger on a partitioned table does NOT propagate to partitions, so one is created on the parent AND on each existing partition.
--   4. ENABLE ALWAYS: all guards are ENABLE ALWAYS, so they ALSO fire under `session_replication_role = replica` (the usual superuser bypass of triggers).
--   5. SELF-CHECK: `fn_audit_log_protection_gaps()` lists every partition that lacks a guard or holds a privilege it must not — the check a future partition-creating migration must run (see RESIDUAL).
--
-- RESIDUAL RISKS (NOT closed here — stated so the reviewer decides, nothing is silently authorised)
--   * the table OWNER / a superuser can still run DDL: ALTER TABLE … DISABLE TRIGGER, DROP the guard, DETACH / DROP a partition, DROP the table. Triggers cannot prevent DDL. flower_migrate is the owner in
--     production and is not an application role; its use is a deployment-process control (and an event trigger would need a superuser to install).
--   * a NEW partition created later is a new table: the default privileges grant it UPDATE / DELETE again and it carries no TRUNCATE trigger. The cloned row guard still refuses UPDATE / DELETE; the
--     TRUNCATE privilege is not in the defaults; and `fn_audit_log_protection_gaps()` reports the gap — the migration that creates the partition MUST revoke + add the TRUNCATE guard and be gated on it.
--   * NOT done, by design: refused-attempt auditing, a retention / purge mechanism (a purge would need its OWN approved, privileged procedure — none exists today), and the per-tenant HASH CHAIN
--     (`prevHash` / `entryHash` are unwritten, OD-P2-1). A chain writer must compute the hash AT INSERT (a BEFORE INSERT trigger or the app): this guard refuses any later UPDATE of those columns.
--
-- ACTIVATION COUPLING: the existing Phase 1 test `packages/db/test/migration.test.ts` ("tenant B cannot read, update or delete tenant A rows") asserts that tenant B's `DELETE FROM audit_log` returns ZERO rows;
-- after this migration that statement is REFUSED (permission denied) — stronger, and the assertion must be amended in the same reviewed change (the package's pin amendments do it).
-- Rollback: see rollback.sql in the package (restores the previous, vulnerable state exactly; safe at any time — no row is touched either way).

-- ══════════════ 1. explicit privileges ══════════════
REVOKE ALL ON "audit_log", "audit_log_default" FROM PUBLIC, flower_app, flower_platform;
GRANT SELECT, INSERT ON "audit_log", "audit_log_default" TO flower_app, flower_platform;
REVOKE UPDATE, DELETE, TRUNCATE ON "audit_log", "audit_log_default" FROM flower_migrate;

-- ══════════════ 2. append-only row guard (cloned onto every partition) ══════════════
CREATE FUNCTION fn_audit_log_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only: % is never permitted (id=%)', TG_OP, OLD."id";
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_audit_log_append_only BEFORE UPDATE OR DELETE ON "audit_log" FOR EACH ROW EXECUTE FUNCTION fn_audit_log_append_only();

-- ══════════════ 3. TRUNCATE guard: the parent AND every existing partition (a statement trigger does not propagate) ══════════════
CREATE FUNCTION fn_audit_log_no_truncate() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only / never truncated (%)', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_audit_log_no_truncate BEFORE TRUNCATE ON "audit_log" FOR EACH STATEMENT EXECUTE FUNCTION fn_audit_log_no_truncate();
CREATE TRIGGER trg_audit_log_default_no_truncate BEFORE TRUNCATE ON "audit_log_default" FOR EACH STATEMENT EXECUTE FUNCTION fn_audit_log_no_truncate();

-- ══════════════ 4. the guards also fire under session_replication_role = replica ══════════════
ALTER TABLE "audit_log" ENABLE ALWAYS TRIGGER trg_audit_log_append_only;
ALTER TABLE "audit_log" ENABLE ALWAYS TRIGGER trg_audit_log_no_truncate;
ALTER TABLE "audit_log_default" ENABLE ALWAYS TRIGGER trg_audit_log_default_no_truncate;

-- ══════════════ 5. the self-check: every gap in the protection of audit_log and of EVERY partition (empty = protected) ══════════════
-- bits of pg_trigger.tgtype: ROW 1, BEFORE 2, DELETE 8, UPDATE 16, TRUNCATE 32; tgenabled 'A' = ENABLE ALWAYS
CREATE FUNCTION fn_audit_log_protection_gaps() RETURNS TABLE ("relation" text, "gap" text) AS $$
  WITH rels AS (SELECT t.relid, t.relid::regclass::text AS rel FROM pg_partition_tree('"audit_log"'::regclass) t)
  SELECT r.rel, 'MISSING_APPEND_ONLY_GUARD'
    FROM rels r
   WHERE NOT EXISTS (SELECT 1 FROM pg_trigger g
                      WHERE g.tgrelid = r.relid AND NOT g.tgisinternal AND g.tgfoid = 'fn_audit_log_append_only'::regproc
                        AND (g.tgtype & 1) = 1 AND (g.tgtype & 2) = 2 AND (g.tgtype & 8) = 8 AND (g.tgtype & 16) = 16 AND g.tgenabled = 'A')
  UNION ALL
  SELECT r.rel, 'MISSING_TRUNCATE_GUARD'
    FROM rels r
   WHERE NOT EXISTS (SELECT 1 FROM pg_trigger g
                      WHERE g.tgrelid = r.relid AND NOT g.tgisinternal AND g.tgfoid = 'fn_audit_log_no_truncate'::regproc
                        AND (g.tgtype & 1) = 0 AND (g.tgtype & 2) = 2 AND (g.tgtype & 32) = 32 AND g.tgenabled = 'A')
  UNION ALL
  SELECT r.rel, ro.rolname || ' holds ' || p.priv
    FROM rels r
    CROSS JOIN (VALUES ('flower_app'), ('flower_platform'), ('flower_migrate')) ro(rolname)
    CROSS JOIN (VALUES ('UPDATE'), ('DELETE'), ('TRUNCATE')) p(priv)
   WHERE has_table_privilege(ro.rolname, r.relid, p.priv)
  UNION ALL
  SELECT r.rel, ro.rolname || ' holds ' || p.priv
    FROM rels r
    CROSS JOIN (VALUES ('flower_app'), ('flower_platform')) ro(rolname)
    CROSS JOIN (VALUES ('REFERENCES'), ('TRIGGER')) p(priv)
   WHERE has_table_privilege(ro.rolname, r.relid, p.priv)
  UNION ALL
  SELECT r.rel, 'PUBLIC holds ' || a.privilege_type
    FROM rels r
    JOIN pg_class c ON c.oid = r.relid
    CROSS JOIN LATERAL aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
   WHERE a.grantee = 0
$$ LANGUAGE sql STABLE;
REVOKE ALL ON FUNCTION fn_audit_log_protection_gaps() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_audit_log_protection_gaps() TO flower_platform, flower_migrate;
