-- SECURITY PREFLIGHT — READ-ONLY catalog checks for AL1 (audit_log immutability) and SE1 (security_event isolation).
--
-- WHO RUNS IT: an AUTHORIZED OPERATOR, against staging or production, with their own credentials. This repository never connects to either and never asks for credentials.
-- WHAT IT NEEDS: the ability to read the PostgreSQL system catalogs (any role can). NO superuser, NO access to any table's rows: it reads pg_catalog only, never audit_log / security_event data.
-- WHAT IT CHANGES: nothing. The whole script runs inside BEGIN READ ONLY (the server refuses any write) and ends with ROLLBACK; the single statement is a SELECT.
-- HOW: psql "<connection string>" -X -v ON_ERROR_STOP=1 -f PREFLIGHT.sql          (the output is one table; send it to the reviewer unedited)
--
-- RUN IT TWICE if the migration role differs from the operator's: once with the connection string used to RUN MIGRATIONS (so P21 reports that role's superuser / BYPASSRLS status) and once with any other login.
-- DO NOT ASSUME PRODUCTION MATCHES A DISPOSABLE TEST DATABASE. Ownership, default privileges and role attributes are exactly what this script observes; every verdict is derived from the catalog of the database it is run against.
--
-- COLUMNS: check_id | verdict | subject | observed | expected
-- VERDICTS: PASS (matches the expectation) | FAIL (a release blocker candidate: the reviewer decides) | WARN (works today, fragile or a defence-in-depth gap) | INFO (a fact the reviewer needs; no judgement).
-- A "FAIL" or "WARN" is a finding to be explained, not an automatic stop: see docs/decisions/AL1-SE1-INDEPENDENT-REVIEW-HANDOFF.md for how each check maps to a release blocker.

BEGIN READ ONLY;

WITH
-- ───────────────────────── fixed vocabulary ─────────────────────────
expected_roles(rolname, want_super, want_bypass) AS (
  VALUES ('flower_app', false, false), ('flower_platform', false, true), ('flower_migrate', false, false)
),
privs(p) AS (
  VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')
),
role_rows AS (
  SELECT e.rolname AS want, r.oid AS roloid, r.rolname, r.rolsuper, r.rolbypassrls, r.rolcanlogin, e.want_super, e.want_bypass
  FROM expected_roles e LEFT JOIN pg_roles r ON r.rolname = e.rolname
),
existing_roles AS (SELECT rolname FROM pg_roles WHERE rolname IN ('flower_app', 'flower_platform', 'flower_migrate')),
-- every relation in `public` with its owner's attributes (ownership is what decides RLS-bypass inside a view)
rel AS (
  SELECT c.oid, c.relname, c.relkind, c.relowner, pg_get_userbyid(c.relowner) AS owner,
         o.rolsuper AS owner_super, o.rolbypassrls AS owner_bypass,
         c.relrowsecurity, c.relforcerowsecurity, c.reloptions,
         COALESCE(c.relacl, acldefault('r', c.relowner)) AS acl
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
  JOIN pg_roles o ON o.oid = c.relowner
  WHERE c.relkind IN ('r', 'p', 'v', 'm')
),
-- audit_log: the parent and every partition (guarded: no row when the table does not exist)
audit_tree AS (
  SELECT t.relid FROM pg_partition_tree(COALESCE(to_regclass('public.audit_log'), 'pg_catalog.pg_class'::regclass)) t
  WHERE to_regclass('public.audit_log') IS NOT NULL
),
audit_rel AS (SELECT r.* FROM rel r JOIN audit_tree t ON t.relid = r.oid),
priv_set(oid, rolname, privs) AS (
  SELECT r.oid, er.rolname,
         COALESCE((SELECT string_agg(p.p, ',' ORDER BY p.p) FROM privs p WHERE has_table_privilege(er.rolname, r.oid, p.p)), '')
  FROM rel r CROSS JOIN existing_roles er
),
public_privs AS (
  SELECT r.oid, COALESCE((SELECT string_agg(DISTINCT a.privilege_type, ',' ORDER BY a.privilege_type) FROM aclexplode(r.acl) a WHERE a.grantee = 0), '') AS privs
  FROM rel r
),
inv AS (  -- security_invoker on?
  SELECT r.oid, COALESCE((SELECT bool_or(o ~* '^security_invoker=(true|on|1|yes)$') FROM unnest(r.reloptions) o), false) AS invoker
  FROM rel r
),
checks(check_id, verdict, subject, observed, expected) AS (

-- P01 server version (security_invoker needs 15+)
SELECT 'P01', CASE WHEN current_setting('server_version_num')::int >= 150000 THEN 'PASS' ELSE 'FAIL' END,
       'server', current_setting('server_version'), 'PostgreSQL 15 or newer (security_invoker)'

UNION ALL
-- P02 who is running this (informational; the verdicts do not depend on it)
SELECT 'P02', 'INFO', 'operator', 'current_user=' || current_user || ' session_user=' || session_user ||
       ' superuser=' || (SELECT rolsuper::text FROM pg_roles WHERE rolname = current_user) ||
       ' bypassrls=' || (SELECT rolbypassrls::text FROM pg_roles WHERE rolname = current_user),
       'any'

UNION ALL
-- P10 the three application roles exist with the intended attributes
SELECT 'P10', CASE WHEN rr.rolname IS NULL THEN 'FAIL'
                   WHEN rr.rolsuper = rr.want_super AND rr.rolbypassrls = rr.want_bypass THEN 'PASS' ELSE 'FAIL' END,
       rr.want,
       CASE WHEN rr.rolname IS NULL THEN 'role does not exist'
            ELSE 'superuser=' || rr.rolsuper || ' bypassrls=' || rr.rolbypassrls || ' login=' || rr.rolcanlogin END,
       'superuser=' || rr.want_super || ' bypassrls=' || rr.want_bypass
FROM role_rows rr

UNION ALL
-- P11 flower_app must not be able to become a superuser / BYPASSRLS role or the platform / migration role
SELECT 'P11', CASE WHEN NOT pg_has_role('flower_app', r.rolname, 'MEMBER') THEN 'PASS' ELSE 'FAIL' END,
       'flower_app member of ' || r.rolname,
       pg_has_role('flower_app', r.rolname, 'MEMBER')::text, 'false'
FROM pg_roles r
WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'flower_app')
  AND r.rolname <> 'flower_app'
  AND (r.rolsuper OR r.rolbypassrls OR r.rolname IN ('flower_platform', 'flower_migrate'))
  AND r.rolname NOT LIKE 'pg\_%'

UNION ALL
-- P20 WHO OWNS THE OBJECTS = which role ran the migrations. A superuser / BYPASSRLS owner is not bound by FORCE ROW LEVEL SECURITY.
SELECT 'P20', CASE WHEN r.owner_super OR r.owner_bypass THEN 'WARN' ELSE 'PASS' END,
       r.relname,
       'owner=' || r.owner || ' superuser=' || r.owner_super || ' bypassrls=' || r.owner_bypass,
       'a NOSUPERUSER NOBYPASSRLS owner (the migration comments name flower_migrate)'
FROM rel r WHERE r.relname IN ('_prisma_migrations', 'audit_log', 'login_security_event', 'security_event')

UNION ALL
-- P21 the role of THIS session: run the script with the migration connection string to learn the migration role's attributes
SELECT 'P21', CASE WHEN o.rolsuper OR o.rolbypassrls THEN 'WARN' ELSE 'INFO' END, 'this session',
       'current_user=' || o.rolname || ' superuser=' || o.rolsuper || ' bypassrls=' || o.rolbypassrls ||
       ' member_of_flower_migrate=' || COALESCE(pg_has_role(current_user, 'flower_migrate', 'MEMBER')::text, 'n/a'),
       'when run with the MIGRATION connection string: NOSUPERUSER NOBYPASSRLS'
FROM pg_roles o WHERE o.rolname = current_user

UNION ALL
-- P22 ownership across the schema (how many relations each owner holds)
SELECT 'P22', CASE WHEN bool_or(r.owner_super OR r.owner_bypass) THEN 'WARN' ELSE 'PASS' END, 'public relations by owner',
       string_agg(r.owner || '=' || r.n, ', ' ORDER BY r.owner),
       'owned by NOSUPERUSER NOBYPASSRLS role(s)'
FROM (SELECT owner, owner_super, owner_bypass, count(*) AS n FROM rel GROUP BY owner, owner_super, owner_bypass) r
HAVING count(*) > 0

UNION ALL
-- P23 SECURITY DEFINER functions the application role can execute (they run as their OWNER)
SELECT 'P23', CASE WHEN o.rolsuper OR o.rolbypassrls THEN 'WARN' ELSE 'INFO' END, p.proname,
       'owner=' || o.rolname || ' superuser=' || o.rolsuper || ' bypassrls=' || o.rolbypassrls ||
       ' returns=' || p.prorettype::regtype::text || ' config=' || COALESCE(p.proconfig::text, 'none'),
       'reviewed: trigger-only, pinned search_path, fixed-shape body'
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
JOIN pg_roles o ON o.oid = p.proowner
WHERE p.prosecdef AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'flower_app') AND has_function_privilege('flower_app', p.oid, 'EXECUTE')

UNION ALL
-- P30 EVERY VIEW / MATERIALIZED VIEW in public: can the application role read other tenants through it?
--   EXPOSED  = not security_invoker AND owner bypasses RLS AND flower_app can SELECT   (the SE1 finding)
--   a materialized view ignores RLS entirely, so any readable one is reported
SELECT 'P30',
       CASE WHEN r.relkind = 'm' AND has_table_privilege('flower_app', r.oid, 'SELECT') THEN 'WARN'
            WHEN r.relkind = 'v' AND NOT i.invoker AND (r.owner_super OR r.owner_bypass) AND has_table_privilege('flower_app', r.oid, 'SELECT') THEN 'FAIL'
            WHEN r.relkind = 'v' AND NOT i.invoker AND has_table_privilege('flower_app', r.oid, 'SELECT') THEN 'WARN'
            WHEN r.relkind = 'v' AND i.invoker AND has_table_privilege('flower_app', r.oid, 'SELECT') THEN 'WARN'
            WHEN r.relkind = 'v' AND NOT i.invoker AND (r.owner_super OR r.owner_bypass) THEN 'WARN'
            ELSE 'PASS' END,
       r.relname || CASE r.relkind WHEN 'm' THEN ' (materialized view)' ELSE ' (view)' END,
       'owner=' || r.owner || ' owner_bypasses_rls=' || (r.owner_super OR r.owner_bypass) || ' security_invoker=' || i.invoker ||
       ' flower_app_select=' || has_table_privilege('flower_app', r.oid, 'SELECT'),
       'security_invoker=true AND flower_app has no SELECT (platform-only views); FAIL = flower_app can read other tenants through it'
FROM rel r JOIN inv i ON i.oid = r.oid
WHERE r.relkind IN ('v', 'm') AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'flower_app')

UNION ALL
-- P31 the exact privileges per role on every view / materialized view (SE1 expects: flower_platform SELECT only; flower_app and PUBLIC nothing)
SELECT 'P31',
       CASE WHEN r.relname = 'security_event' AND ps.rolname = 'flower_app' AND ps.privs <> '' THEN 'FAIL'
            WHEN r.relname = 'security_event' AND ps.rolname = 'flower_platform' AND ps.privs <> 'SELECT' THEN 'WARN'
            WHEN r.relname = 'security_event' THEN 'PASS' ELSE 'INFO' END,
       r.relname || ' / ' || ps.rolname, COALESCE(NULLIF(ps.privs, ''), 'none'),
       CASE ps.rolname WHEN 'flower_platform' THEN 'SELECT' WHEN 'flower_app' THEN 'none' ELSE 'none' END
FROM rel r JOIN priv_set ps ON ps.oid = r.oid WHERE r.relkind IN ('v', 'm')
UNION ALL
SELECT 'P31', CASE WHEN r.relname = 'security_event' THEN (CASE WHEN pp.privs <> '' THEN 'FAIL' ELSE 'PASS' END) ELSE 'INFO' END,
       r.relname || ' / PUBLIC', COALESCE(NULLIF(pp.privs, ''), 'none'), 'none'
FROM rel r JOIN public_privs pp ON pp.oid = r.oid WHERE r.relkind IN ('v', 'm')

UNION ALL
-- P40 audit_log (parent AND every partition): effective privileges. AL1 expects SELECT, INSERT only for the application and platform roles.
SELECT 'P40',
       CASE WHEN ps.rolname IN ('flower_app', 'flower_platform') AND ps.privs ~ '(UPDATE|DELETE|TRUNCATE)' THEN 'FAIL'
            WHEN ps.rolname IN ('flower_app', 'flower_platform') AND ps.privs ~ '(REFERENCES|TRIGGER)' THEN 'WARN'
            WHEN ps.rolname = 'flower_migrate' AND ps.privs ~ '(UPDATE|DELETE|TRUNCATE)' THEN 'WARN'
            ELSE 'PASS' END,
       a.relname || ' / ' || ps.rolname, COALESCE(NULLIF(ps.privs, ''), 'none'),
       CASE WHEN ps.rolname = 'flower_migrate' THEN 'no UPDATE / DELETE / TRUNCATE' ELSE 'SELECT,INSERT' END
FROM audit_rel a JOIN priv_set ps ON ps.oid = a.oid
UNION ALL
SELECT 'P40', CASE WHEN pp.privs <> '' THEN 'FAIL' ELSE 'PASS' END, a.relname || ' / PUBLIC', COALESCE(NULLIF(pp.privs, ''), 'none'), 'none'
FROM audit_rel a JOIN public_privs pp ON pp.oid = a.oid
UNION ALL
SELECT 'P40', 'FAIL', 'audit_log', 'table not found in schema public', 'present'
WHERE to_regclass('public.audit_log') IS NULL

UNION ALL
-- P41 audit_log guards present on the parent AND every partition (AL1): a row guard (BEFORE UPDATE OR DELETE, FOR EACH ROW) and a TRUNCATE guard, all ENABLE ALWAYS
SELECT 'P41',
       CASE WHEN g.row_guard AND g.trunc_guard THEN 'PASS' ELSE 'FAIL' END,
       a.relname,
       'row_guard_always=' || g.row_guard || ' truncate_guard_always=' || g.trunc_guard,
       'both true (ENABLE ALWAYS: they also fire under session_replication_role = replica)'
FROM audit_rel a
CROSS JOIN LATERAL (
  SELECT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = a.oid AND NOT t.tgisinternal AND t.tgenabled = 'A'
                  AND (t.tgtype & 1) = 1 AND (t.tgtype & 2) = 2 AND (t.tgtype & 8) = 8 AND (t.tgtype & 16) = 16) AS row_guard,
         EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = a.oid AND NOT t.tgisinternal AND t.tgenabled = 'A'
                  AND (t.tgtype & 32) = 32) AS trunc_guard
) g

UNION ALL
-- P42 audit_log / login_security_event: row level security enabled AND forced, with a policy
SELECT 'P42',
       CASE WHEN r.relrowsecurity AND r.relforcerowsecurity AND (SELECT count(*) FROM pg_policy p WHERE p.polrelid = r.oid) > 0 THEN 'PASS' ELSE 'FAIL' END,
       r.relname,
       'rls=' || r.relrowsecurity || ' force=' || r.relforcerowsecurity || ' policies=' || (SELECT count(*) FROM pg_policy p WHERE p.polrelid = r.oid),
       'rls=true force=true policies>=1'
FROM rel r WHERE r.relname IN ('audit_log', 'login_security_event')

UNION ALL
-- P43 tenant-scoped tables (a "tenantId" column) WITHOUT forced row level security — listed for the reviewer (platform-global tables are expected to be exempt)
SELECT 'P43', CASE WHEN count(*) = 0 THEN 'PASS' ELSE 'INFO' END, 'tenant tables without FORCE RLS',
       COALESCE(string_agg(x.relname, ', ' ORDER BY x.relname), 'none'), 'none (or only documented exemptions)'
FROM (
  SELECT r.relname FROM rel r
  WHERE r.relkind IN ('r', 'p')
    AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = r.oid AND a.attname = 'tenantId' AND NOT a.attisdropped)
    AND NOT r.relforcerowsecurity
) x

UNION ALL
-- P50 DEFAULT PRIVILEGES: what a FUTURE table / view / partition created by each role inherits (the Phase 1 defaults grant S/I/U/D to the application and platform roles)
SELECT 'P50',
       CASE WHEN d.defaclobjtype = 'r' AND EXISTS (SELECT 1 FROM aclexplode(d.defaclacl) a
                  WHERE pg_get_userbyid(a.grantee) IN ('flower_app', 'flower_platform') AND a.privilege_type IN ('UPDATE', 'DELETE', 'TRUNCATE')) THEN 'WARN'
            ELSE 'INFO' END,
       'objects created by ' || pg_get_userbyid(d.defaclrole) || COALESCE(' in schema ' || n.nspname, ' (any schema)') || ' [' || d.defaclobjtype::text || ']',
       (SELECT string_agg(CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END || ':' || a.privilege_type, ', ' ORDER BY a.grantee, a.privilege_type)
          FROM aclexplode(d.defaclacl) a),
       'reviewed: which of these apply to objects the NEXT migration creates is decided by the role that runs it'
FROM pg_default_acl d LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace
UNION ALL
SELECT 'P50', 'INFO', 'default privileges', 'no pg_default_acl rows', 'n/a'
WHERE NOT EXISTS (SELECT 1 FROM pg_default_acl)
)
SELECT check_id, verdict, subject, observed, expected
FROM checks
ORDER BY check_id,
         CASE verdict WHEN 'FAIL' THEN 0 WHEN 'WARN' THEN 1 WHEN 'INFO' THEN 2 ELSE 3 END,
         subject;

ROLLBACK;
