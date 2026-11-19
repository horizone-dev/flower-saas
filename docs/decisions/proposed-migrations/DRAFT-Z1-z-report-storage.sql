-- DRAFT Z1 — NOT APPLIED, NOT IN packages/db/prisma/migrations. A PROPOSAL for owner / accountant review (Z-SALES-ATTRIBUTION-DECISION D-A1…D-A5, S-9).
-- Immutable Z-Report storage with DATABASE-enforced gapless per-register numbering, a hash-linked chain, concurrent-close protection, an atomic
-- shift close (a session cannot be CLOSED without its Z, and a Z cannot outlive an unclosed session) and approved-variance handling.
--
-- PREREQUISITE: DRAFT D (`register_session_count`) is applied first — the Z's counted cash, counter and expected cash are RE-DERIVED in the database from
-- the latest CLOSE count and the ledger, never trusted from the caller. The application model this must agree with line by line is
-- apps/api/src/modules/cash-register/z-report.ts (pure, tested) and the store z-report-store.ts (inert, tested on a disposable database).
--
-- WHAT THE DATABASE CANNOT PROVE (and does not pretend to): that `content` hashes to `hash` (canonical JSON + SHA-256 stay in the application, re-verified by
-- `verifyZChain`), and the sales facts inside `content` (re-checked by the source verifier). It DOES prove: ordering, gaplessness, linkage, uniqueness,
-- immutability, scope, currency, session state, the re-derived cash figures, the variance approval rule and the no-overlap rule.
--
-- ACTIVATION COUPLING (read before applying): this REPLACES the close guard of DRAFT D — a session may become CLOSED only after its Z exists in the SAME
-- transaction. The existing close flow (which writes no Z) is refused until the close transaction of the design document is deployed: apply together.
--
-- ORDER IS ENFORCED: this file refuses to run unless DRAFT D is already applied (the guard just below), so the two can never be promoted in the wrong order.
--
-- NOT DECIDED HERE: S-9 (whether a difference may be accepted and how it is POSTED — this migration only stores the approved variance, it posts nothing),
-- gross / discount presentation, retention of `content`. Rollback: DROP in reverse order and re-create DRAFT D's close guard (section 7).

DO $$
BEGIN
  IF to_regclass('register_session_count') IS NULL
     OR to_regprocedure('fn_register_session_close_requires_count()') IS NULL THEN
    RAISE EXCEPTION 'DRAFT Z1 requires DRAFT D (register_session_count and its close guard) to be applied first';
  END IF;
END
$$;

CREATE TABLE "z_report" (
    "id"                    UUID NOT NULL DEFAULT uuidv7(),
    "tenantId"              UUID NOT NULL,
    "companyId"             UUID NOT NULL,
    "branchId"              UUID NOT NULL,
    "posTerminalId"         UUID NOT NULL,
    "cashRegisterId"        UUID NOT NULL,
    "registerSessionId"     UUID NOT NULL,
    "currencyCode"          TEXT NOT NULL,
    "currencyExponent"      SMALLINT NOT NULL,
    -- gapless per register: 1, 2, 3 … (the trigger enforces "previous + 1" under the register-row lock; never a SEQUENCE, which gaps on rollback)
    "zNumber"               BIGINT NOT NULL,
    -- the hash chain: prevHash = the previous Z's hash (the register's genesis for number 1); hash = SHA-256 over domain + prevHash + canonical content
    "prevHash"              TEXT NOT NULL,
    "hash"                  TEXT NOT NULL,
    -- the database instant of the close (the end of the shift window); the session row records no close instant of its own
    "closedAt"              TIMESTAMPTZ(6) NOT NULL,
    -- re-derived by the trigger: expected = Σ ledger (excl. CLOSING); counted / counter = the latest CLOSE count
    "expectedMinor"         BIGINT NOT NULL,
    "countedMinor"          BIGINT NOT NULL,
    "varianceMinor"         BIGINT NOT NULL,
    "countedByUserId"       UUID NOT NULL,
    -- a difference needs an EXACT approval by someone other than the counter (the application model's rule, enforced here too)
    "approvedByUserId"      UUID,
    "approvedVarianceMinor" BIGINT,
    -- the owner-approved attribution basis in force when the Z was closed (D-A1…D-A5)
    "attributionBasis"      TEXT NOT NULL,
    -- the frozen canonical report WITHOUT its number / links (those are columns); bigints are decimal strings
    "content"               JSONB NOT NULL,
    "createdByUserId"       UUID NOT NULL,
    "createdAt"             TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- NO updatedAt (append-only) and NO free-text column

    CONSTRAINT "z_report_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "z_report_znumber_chk" CHECK ("zNumber" >= 1),
    CONSTRAINT "z_report_hash_shape_chk" CHECK ("hash" ~ '^[0-9a-f]{64}$' AND "prevHash" ~ '^[0-9a-f]{64}$' AND "hash" <> "prevHash"),
    CONSTRAINT "z_report_currency_shape_chk" CHECK ("currencyCode" ~ '^[A-Z]{3}$'),
    CONSTRAINT "z_report_exponent_range_chk" CHECK ("currencyExponent" BETWEEN 0 AND 3),
    CONSTRAINT "z_report_counted_chk" CHECK ("countedMinor" >= 0),
    CONSTRAINT "z_report_variance_chk" CHECK ("varianceMinor" = "countedMinor" - "expectedMinor"),
    -- no difference ⇒ no approval; a difference ⇒ an exact approval by someone other than the counter
    CONSTRAINT "z_report_variance_approval_chk" CHECK (
      ("varianceMinor" = 0 AND "approvedByUserId" IS NULL AND "approvedVarianceMinor" IS NULL)
      OR ("varianceMinor" <> 0 AND "approvedByUserId" IS NOT NULL AND "approvedByUserId" <> "countedByUserId"
          AND "approvedVarianceMinor" = "varianceMinor")),
    CONSTRAINT "z_report_attribution_basis_chk" CHECK ("attributionBasis" IN ('ORDER_TERMINAL_ISSUED_AT_WINDOW')),
    -- only a FINALIZABLE report (no blocker) is ever stored
    CONSTRAINT "z_report_content_chk" CHECK (
      jsonb_typeof("content") = 'object'
      AND "content" ->> 'kind' = 'Z_REPORT'
      AND "content" ->> 'version' = '1'
      AND jsonb_typeof("content" -> 'blockers') = 'array' AND jsonb_array_length("content" -> 'blockers') = 0
      AND "content" ->> 'finalizable' = 'true')
);

-- one Z per session; one Z per (register, number); a head has exactly ONE successor (no fork); a hash is never reused
CREATE UNIQUE INDEX "z_report_session_key" ON "z_report"("tenantId", "registerSessionId");
CREATE UNIQUE INDEX "z_report_register_number_key" ON "z_report"("tenantId", "cashRegisterId", "zNumber");
CREATE UNIQUE INDEX "z_report_register_prevhash_key" ON "z_report"("tenantId", "cashRegisterId", "prevHash");
CREATE UNIQUE INDEX "z_report_hash_key" ON "z_report"("tenantId", "hash");
CREATE INDEX "z_report_tenantId_branchId_closedAt_idx" ON "z_report"("tenantId", "branchId", "closedAt");

ALTER TABLE "z_report"
  ADD CONSTRAINT "z_report_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenant"("id") ON UPDATE CASCADE ON DELETE CASCADE,
  -- proves the Z's company / branch / terminal / register AND currency all equal its session's
  ADD CONSTRAINT "z_report_session_scope_fkey"
    FOREIGN KEY ("tenantId", "companyId", "branchId", "posTerminalId", "cashRegisterId", "registerSessionId", "currencyCode", "currencyExponent")
    REFERENCES "register_session"("tenantId", "companyId", "branchId", "posTerminalId", "cashRegisterId", "id", "currencyCode", "currencyExponent")
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  ADD CONSTRAINT "z_report_counter_fkey" FOREIGN KEY ("countedByUserId") REFERENCES "user"("id") ON UPDATE NO ACTION ON DELETE NO ACTION,
  ADD CONSTRAINT "z_report_approver_fkey" FOREIGN KEY ("approvedByUserId") REFERENCES "user"("id") ON UPDATE NO ACTION ON DELETE NO ACTION,
  ADD CONSTRAINT "z_report_creator_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "user"("id") ON UPDATE NO ACTION ON DELETE NO ACTION;

-- ══════════════ 1. the insert guard: ONE lock order (register → session), number, link, re-derived cash, overlap, content ══════════════
CREATE FUNCTION fn_z_report_guard() RETURNS trigger AS $$
DECLARE
  sess        RECORD;
  prev        RECORD;
  cnt         RECORD;
  ledger_sum  BIGINT;
BEGIN
  -- (1) the register row is THE serialisation point: one Z at a time per register; different registers never block each other.
  PERFORM 1 FROM "cash_register" r WHERE r."id" = NEW."cashRegisterId" AND r."tenantId" = NEW."tenantId" FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'z_report: cash_register % not found', NEW."cashRegisterId";
  END IF;
  -- (2) then the session
  SELECT s."status", s."openedAt" INTO sess
    FROM "register_session" s WHERE s."id" = NEW."registerSessionId" AND s."tenantId" = NEW."tenantId" FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'z_report: register_session % not found', NEW."registerSessionId";
  END IF;
  IF sess."status" <> 'COUNTING' THEN
    RAISE EXCEPTION 'z_report: register_session % is % (a Z is written while the session is COUNTING, in the close transaction)', NEW."registerSessionId", sess."status"
      USING ERRCODE = 'check_violation';
  END IF;
  -- the window: it starts at the opening and may not end in the future
  IF NEW."closedAt" < sess."openedAt" OR NEW."closedAt" > clock_timestamp() THEN
    RAISE EXCEPTION 'z_report: closedAt % is outside [session openedAt, now]', NEW."closedAt" USING ERRCODE = 'check_violation';
  END IF;
  -- (D-A5) NO OVERLAP: no other session of this register / terminal opened inside the window, none still unresolved from before it
  IF EXISTS (
       SELECT 1 FROM "register_session" o
        WHERE o."tenantId" = NEW."tenantId" AND o."id" <> NEW."registerSessionId"
          AND (o."cashRegisterId" = NEW."cashRegisterId" OR o."posTerminalId" = NEW."posTerminalId")
          AND ((o."openedAt" >= sess."openedAt" AND o."openedAt" < NEW."closedAt")
               OR (o."openedAt" < sess."openedAt" AND o."status" <> 'CLOSED'))) THEN
    RAISE EXCEPTION 'z_report: another session of register % overlaps the window of session %', NEW."cashRegisterId", NEW."registerSessionId"
      USING ERRCODE = 'check_violation';
  END IF;

  -- (3) gapless number and link, under the register lock
  SELECT z."zNumber", z."hash", z."closedAt" INTO prev
    FROM "z_report" z WHERE z."tenantId" = NEW."tenantId" AND z."cashRegisterId" = NEW."cashRegisterId"
   ORDER BY z."zNumber" DESC LIMIT 1;
  IF NEW."zNumber" <> coalesce(prev."zNumber", 0) + 1 THEN
    RAISE EXCEPTION 'z_report: zNumber must be % (got %)', coalesce(prev."zNumber", 0) + 1, NEW."zNumber" USING ERRCODE = 'check_violation';
  END IF;
  IF prev."zNumber" IS NOT NULL THEN
    IF NEW."prevHash" <> prev."hash" THEN
      RAISE EXCEPTION 'z_report: prevHash does not link to the previous Z of register % (number %)', NEW."cashRegisterId", prev."zNumber" USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."closedAt" < prev."closedAt" THEN
      RAISE EXCEPTION 'z_report: closedAt precedes the previous Z of register %', NEW."cashRegisterId" USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- (4) the cash figures are RE-DERIVED, never trusted: expected = the ledger, counted / counter = the latest CLOSE count, which must be fresh
  SELECT c."purpose", c."countedMinor", c."expectedMinor", c."countedByUserId" INTO cnt
    FROM "register_session_count" c WHERE c."registerSessionId" = NEW."registerSessionId" AND c."tenantId" = NEW."tenantId"
   ORDER BY c."seq" DESC LIMIT 1;
  IF NOT FOUND OR cnt."purpose" <> 'CLOSE' THEN
    RAISE EXCEPTION 'z_report: session % has no CLOSE count as its latest count', NEW."registerSessionId" USING ERRCODE = 'check_violation';
  END IF;
  SELECT coalesce(sum(m."amountMinor"), 0) INTO ledger_sum
    FROM "cash_movement" m WHERE m."registerSessionId" = NEW."registerSessionId" AND m."tenantId" = NEW."tenantId" AND m."type" <> 'CLOSING';
  IF cnt."expectedMinor" <> ledger_sum THEN
    RAISE EXCEPTION 'z_report: the close count is stale (the ledger changed after it)' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."expectedMinor" <> ledger_sum OR NEW."countedMinor" <> cnt."countedMinor" OR NEW."countedByUserId" <> cnt."countedByUserId" THEN
    RAISE EXCEPTION 'z_report: expected % / counted % / counter do not equal the ledger % / latest CLOSE count %', NEW."expectedMinor", NEW."countedMinor", ledger_sum, cnt."countedMinor"
      USING ERRCODE = 'check_violation';
  END IF;

  -- (5) the people belong to THIS tenant
  IF NOT EXISTS (SELECT 1 FROM "user" u WHERE u."id" = NEW."createdByUserId" AND u."tenantId" = NEW."tenantId")
     OR (NEW."approvedByUserId" IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM "user" u WHERE u."id" = NEW."approvedByUserId" AND u."tenantId" = NEW."tenantId")) THEN
    RAISE EXCEPTION 'z_report: a referenced user does not exist in this tenant' USING ERRCODE = 'check_violation';
  END IF;

  -- (6) the stored content describes THIS row (a stored report cannot be about another session, register, currency or figure)
  IF NEW."content" ->> 'registerId' IS DISTINCT FROM NEW."cashRegisterId"::text
     OR NEW."content" ->> 'sessionId' IS DISTINCT FROM NEW."registerSessionId"::text
     OR NEW."content" ->> 'currency' IS DISTINCT FROM NEW."currencyCode"
     OR (NEW."content" ->> 'closedAt')::timestamptz IS DISTINCT FROM NEW."closedAt"
     OR NEW."content" #>> '{cash,expectedCash,amountMinor}' IS DISTINCT FROM NEW."expectedMinor"::text
     OR NEW."content" #>> '{overShort,variance,amountMinor}' IS DISTINCT FROM NEW."varianceMinor"::text
     OR NEW."content" #>> '{attributionPolicy,basis}' IS DISTINCT FROM NEW."attributionBasis" THEN
    RAISE EXCEPTION 'z_report: content does not match the row (register / session / currency / closedAt / expected / variance / basis)' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_z_report_guard
  BEFORE INSERT ON "z_report"
  FOR EACH ROW EXECUTE FUNCTION fn_z_report_guard();

-- ══════════════ 2. append-only: no UPDATE, no DELETE, ever (for every role, the owner included) ══════════════
CREATE FUNCTION fn_z_report_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'z_report is append-only: % is never permitted (id=%)', TG_OP, OLD."id";
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_z_report_append_only
  BEFORE UPDATE OR DELETE ON "z_report"
  FOR EACH ROW EXECUTE FUNCTION fn_z_report_append_only();

-- TRUNCATE does not fire row triggers: only the table owner / a superuser can run it, so it is closed here as well (statement-level, same refusal)
CREATE FUNCTION fn_z_report_no_truncate() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'z_report is append-only: TRUNCATE is never permitted';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_z_report_no_truncate
  BEFORE TRUNCATE ON "z_report"
  FOR EACH STATEMENT EXECUTE FUNCTION fn_z_report_no_truncate();

-- ══════════════ 3. atomic close, direction 1: a Z cannot outlive an unclosed session ══════════════
-- Checked at COMMIT (deferred): the close transaction inserts the Z while the session is COUNTING and moves it to CLOSED before it commits.
CREATE FUNCTION fn_z_report_session_closed() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "register_session" s WHERE s."id" = NEW."registerSessionId" AND s."tenantId" = NEW."tenantId" AND s."status" = 'CLOSED') THEN
    RAISE EXCEPTION 'z_report % was written but register_session % is not CLOSED at commit', NEW."id", NEW."registerSessionId" USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER trg_z_report_session_closed
  AFTER INSERT ON "z_report"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION fn_z_report_session_closed();

-- ══════════════ 4. atomic close, direction 2 (REPLACES DRAFT D's close guard): a session cannot be CLOSED without its Z ══════════════
-- DRAFT D required a balanced count. The variance rule now lives where the figures are frozen — the Z (exact approval by someone other than the counter) —
-- so the close needs: a fresh CLOSE count (unchanged) AND the Z of this session, written in the same transaction.
CREATE OR REPLACE FUNCTION fn_register_session_close_requires_count() RETURNS trigger AS $$
DECLARE
  last_purpose  TEXT;
  last_expected BIGINT;
  ledger_sum    BIGINT;
BEGIN
  IF NEW."status" = 'CLOSED' AND OLD."status" <> 'CLOSED' THEN
    SELECT c."purpose", c."expectedMinor" INTO last_purpose, last_expected
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
    IF NOT EXISTS (SELECT 1 FROM "z_report" z WHERE z."registerSessionId" = NEW."id" AND z."tenantId" = NEW."tenantId") THEN
      RAISE EXCEPTION 'register_session %: a close requires its Z-Report, written in the same transaction', NEW."id";
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ══════════════ 5. grants + Row-Level Security (same shape as cash_movement / register_session_count) ══════════════
-- The Phase 1 ALTER DEFAULT PRIVILEGES grants SELECT, INSERT, UPDATE, DELETE to flower_app AND flower_platform on EVERY new table. Revoking only UPDATE / DELETE
-- would leave the access matrix dependent on that default (a later default such as TRUNCATE or REFERENCES would silently widen it, and the INSERT grant below
-- would be decorative). So EVERYTHING is revoked first and exactly SELECT + INSERT are granted back: these two statements are the ONLY access the roles hold.
GRANT ALL ON "z_report" TO flower_migrate;
REVOKE ALL ON "z_report" FROM PUBLIC, flower_platform, flower_app;
GRANT SELECT, INSERT ON "z_report" TO flower_platform, flower_app;

ALTER TABLE "z_report" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "z_report_tenant_branch_isolation" ON "z_report"
  USING (
    "tenantId" = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND (
      nullif(current_setting('app.branch_id', true), '') IS NULL
      OR "branchId" = nullif(current_setting('app.branch_id', true), '')::uuid
    )
  )
  WITH CHECK (
    "tenantId" = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND (
      nullif(current_setting('app.branch_id', true), '') IS NULL
      OR "branchId" = nullif(current_setting('app.branch_id', true), '')::uuid
    )
  );
ALTER TABLE "z_report" FORCE ROW LEVEL SECURITY;

-- ══════════════ 6. COMPANION changes (NOT made here) ══════════════
--   * Prisma model `ZReport` in schema.prisma (triggers / partial behaviour stay in SQL) + the schema-drift ratchet entry;
--   * the close transaction (design document §2.3): lock register → lock session → re-read → pure build → refuse on any blocker → finalizeZReport → INSERT z_report
--     → CLOSING movement → UPDATE session CLOSED → audit + outbox, all in ONE transaction; `Idempotency-Key` (ADR-0022);
--   * the policy token (owner / accountant approval of Z-SALES-ATTRIBUTION-DECISION) and the S-9 variance decision BEFORE any close route is enabled;
--   * amendments to the cash-register structural pins that currently forbid a z_report table.

-- ══════════════ 7. ROLLBACK (safe while no Z exists; afterwards the table is evidence — keep it) ══════════════
--   DROP TRIGGER trg_z_report_session_closed ON "z_report"; DROP FUNCTION fn_z_report_session_closed();
--   DROP TRIGGER trg_z_report_append_only ON "z_report";   DROP FUNCTION fn_z_report_append_only();
--   DROP TRIGGER trg_z_report_guard ON "z_report";         DROP FUNCTION fn_z_report_guard();
--   DROP TABLE "z_report";
--   then re-create DRAFT D's fn_register_session_close_requires_count() (it also requires a zero variance).
