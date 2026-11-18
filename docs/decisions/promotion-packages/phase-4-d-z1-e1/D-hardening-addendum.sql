-- D HARDENING ADDENDUM — appended to the DRAFT D body in promotion candidate step 1. NOT part of DRAFT-D (which stays byte-identical); it applies the DRAFT-Z1 grant-hardening lessons to
-- `register_session_count` so that its access never depends on the Phase 1 ALTER DEFAULT PRIVILEGES:
--   (a) DRAFT D only REVOKEs UPDATE and DELETE from the application roles. Today that yields exactly SELECT + INSERT, but only because the default privileges happen not to grant
--       TRUNCATE / REFERENCES / TRIGGER and PUBLIC holds nothing; a changed default would silently widen it. Here EVERYTHING is revoked, then exactly SELECT + INSERT are granted back.
--   (b) the table is append-only for UPDATE and DELETE (row triggers) but a ROW trigger cannot see TRUNCATE: a statement trigger refuses it, exactly as `z_report` and the E1 tables do.
-- Additive: no existing object is altered. Rollback: DROP TRIGGER trg_register_session_count_no_truncate; DROP FUNCTION fn_register_session_count_no_truncate(); the privilege change is
-- idempotent and is undone by the table's own DROP in the package rollback.

REVOKE ALL ON "register_session_count" FROM PUBLIC, flower_platform, flower_app;
GRANT SELECT, INSERT ON "register_session_count" TO flower_platform, flower_app;

CREATE FUNCTION fn_register_session_count_no_truncate() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'register_session_count is append-only / never truncated';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_register_session_count_no_truncate BEFORE TRUNCATE ON "register_session_count" FOR EACH STATEMENT EXECUTE FUNCTION fn_register_session_count_no_truncate();
