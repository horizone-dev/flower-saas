-- PROMOTION ROLLBACK 2 of 3 (Z1: Z-Report storage; restores DRAFT D close guard) — UNAPPLIED. Safe only while the tables hold no rows; afterwards they are evidence and are kept. Run 3, then 2, then 1.

DROP TABLE "z_report";
DROP FUNCTION fn_z_report_session_closed();
DROP FUNCTION fn_z_report_no_truncate();
DROP FUNCTION fn_z_report_append_only();
DROP FUNCTION fn_z_report_guard();
-- Z1 REPLACED D's close guard; undo that by putting D's body back (the trigger on register_session is D's and is left in place)
CREATE OR REPLACE FUNCTION fn_register_session_close_requires_count() RETURNS trigger AS $$
DECLARE
  last_purpose  TEXT;
  last_variance BIGINT;
  last_expected BIGINT;
  ledger_sum    BIGINT;
BEGIN
  IF NEW."status" = 'CLOSED' AND OLD."status" <> 'CLOSED' THEN
    SELECT c."purpose", c."varianceMinor", c."expectedMinor" INTO last_purpose, last_variance, last_expected
      FROM "register_session_count" c
     WHERE c."registerSessionId" = NEW."id" AND c."tenantId" = NEW."tenantId"
     ORDER BY c."seq" DESC LIMIT 1;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'register_session %: a close requires a recorded count', NEW."id";
    END IF;
    IF last_purpose <> 'CLOSE' THEN
      RAISE EXCEPTION 'register_session %: the latest count is not a CLOSE count', NEW."id";
    END IF;
    SELECT coalesce(sum(m."amountMinor"), 0) INTO ledger_sum
      FROM "cash_movement" m
     WHERE m."registerSessionId" = NEW."id" AND m."tenantId" = NEW."tenantId" AND m."type" <> 'CLOSING';
    IF last_expected <> ledger_sum THEN
      RAISE EXCEPTION 'register_session %: the close count is stale (the ledger changed after it)', NEW."id";
    END IF;
    IF last_variance <> 0 THEN
      RAISE EXCEPTION 'register_session %: a close needs a balanced count (variance %)', NEW."id", last_variance;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
