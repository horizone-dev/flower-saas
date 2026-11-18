-- PROMOTION ROLLBACK AL1 — UNAPPLIED. Restores the PREVIOUS (vulnerable) state exactly: the guards and the self-check are dropped and the Phase 1 default privileges are re-granted.
-- No audit row is read, written or changed by either direction. Rolling back re-opens the vulnerability: do it only to undo a faulty deployment.

DROP FUNCTION fn_audit_log_protection_gaps();
DROP TRIGGER trg_audit_log_default_no_truncate ON "audit_log_default";
DROP TRIGGER trg_audit_log_no_truncate ON "audit_log";
DROP TRIGGER trg_audit_log_append_only ON "audit_log";
DROP FUNCTION fn_audit_log_no_truncate();
DROP FUNCTION fn_audit_log_append_only();
GRANT SELECT, INSERT, UPDATE, DELETE ON "audit_log", "audit_log_default" TO flower_app, flower_platform;
GRANT ALL ON "audit_log", "audit_log_default" TO flower_migrate;
