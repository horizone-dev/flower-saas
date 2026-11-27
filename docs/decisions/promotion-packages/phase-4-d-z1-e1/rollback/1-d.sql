-- PROMOTION ROLLBACK 1 of 3 (D: register-session count) — UNAPPLIED. Safe only while the tables hold no rows; afterwards they are evidence and are kept. Run 3, then 2, then 1.

DROP TRIGGER trg_register_session_close_requires_count ON "register_session";
DROP FUNCTION fn_register_session_close_requires_count();
DROP TABLE "register_session_count";
DROP FUNCTION fn_register_session_count_no_truncate();
DROP FUNCTION fn_register_session_count_append_only();
DROP FUNCTION fn_register_session_count_guard();
