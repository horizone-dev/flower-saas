-- PROMOTION ROLLBACK SE1 — UNAPPLIED. Restores the PREVIOUS (owner-executed, application-readable) state exactly.
-- Rolling back RE-OPENS the cross-tenant read where the view owner bypasses RLS: do it only to undo a faulty deployment.

ALTER VIEW "security_event" RESET (security_invoker);
GRANT SELECT, INSERT, UPDATE, DELETE ON "security_event" TO flower_app, flower_platform;
