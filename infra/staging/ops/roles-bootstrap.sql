-- Cluster roles a Flower dump refers to. `pg_dump` of ONE database never carries cluster-level objects, and the roles are created by migrations
-- inside the SOURCE cluster, so a restore onto a FRESH server fails (role "flower_app" does not exist) unless these exist first.
-- Run as a superuser on the fresh cluster BEFORE pg_restore:   psql -U postgres -v ON_ERROR_STOP=1 -f roles-bootstrap.sql
-- Idempotent. Attributes are copied from the migrations (phase_1_identity_tenancy_rbac, outbox_dispatcher_least_privilege). All four are NOLOGIN:
-- no secret is created here (the login passwords for flower_app / flower_platform are set afterwards by infra/migrate/provision-db-roles.mjs).
-- FAILS CLOSED if a role already exists with different attributes (a flipped BYPASSRLS or SUPERUSER must never be accepted silently).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'flower_app') THEN
    CREATE ROLE flower_app NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'flower_platform') THEN
    CREATE ROLE flower_platform NOLOGIN NOSUPERUSER BYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'flower_migrate') THEN
    CREATE ROLE flower_migrate NOLOGIN NOSUPERUSER NOBYPASSRLS CREATEDB;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'flower_dispatcher') THEN
    CREATE ROLE flower_dispatcher NOLOGIN NOSUPERUSER BYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END
$$;

DO $$
DECLARE
  bad text;
BEGIN
  SELECT string_agg(rolname, ', ' ORDER BY rolname) INTO bad
  FROM pg_roles r
  JOIN (VALUES
    ('flower_app',        false, false, false, false),
    ('flower_platform',   false, true,  false, false),
    ('flower_migrate',    false, false, true,  false),
    ('flower_dispatcher', false, true,  false, false)
  ) AS want(name, su, bypass, createdb, createrole) ON want.name = r.rolname
  WHERE r.rolsuper <> want.su
     OR r.rolbypassrls <> want.bypass
     OR r.rolcreatedb <> want.createdb
     OR r.rolcreaterole <> want.createrole;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'refused: role(s) % exist with attributes that differ from the migrations (superuser / bypassrls / createdb / createrole)', bad;
  END IF;
END
$$;
