-- DRAFT D — NOT APPLIED, NOT IN packages/db/prisma/migrations. A PROPOSAL for owner approval (decision sheet E-2 / E-3 / E-4 / D-5).
-- The persisted CASH COUNT of a register session: one immutable row per count, denominations as evidence, who counted and who verified, expected
-- vs counted, shortage / overage, and DATABASE-enforced protection against a count racing a close. ONE new table, its triggers, grants and RLS;
-- NO change to any existing table; NO journal, NO account, NO posting. The application model it must agree with line by line is
-- apps/api/src/modules/cash-register/count-record.ts (pure, tested). It does NOT decide whether a difference may be accepted (S-9 / D-1…D-5):
-- the close rule below is TODAY's rule (a close needs a balanced count) and is the one trigger a later decision replaces.
--
-- COMPANION changes (NOT made here): the Prisma model `RegisterSessionCount` in schema.prisma (partial indexes / triggers stay in SQL, like
-- register_session) + the schema-drift ratchet entry; a repository that writes the count BEFORE the close (the existing close flow would be
-- refused by the close trigger until then — apply together); amendments to the cash-register structural pins.
-- Rollback: DROP TRIGGER / FUNCTION / TABLE in reverse order (safe while no count has been recorded; afterwards the table is evidence — keep it).

CREATE TABLE "register_session_count" (
    "id"                UUID NOT NULL DEFAULT uuidv7(),
    "tenantId"          UUID NOT NULL,
    "companyId"         UUID NOT NULL,
    "branchId"          UUID NOT NULL,
    "posTerminalId"     UUID NOT NULL,
    "cashRegisterId"    UUID NOT NULL,
    "registerSessionId" UUID NOT NULL,
    -- 1-based, contiguous within a session (the trigger enforces "previous + 1" under the session lock)
    "seq"               INTEGER NOT NULL,
    -- SPOT = a count that changes nothing; CLOSE = the count a close relies on
    "purpose"           TEXT NOT NULL,
    "currencyCode"      TEXT NOT NULL,
    "currencyExponent"  SMALLINT NOT NULL,
    -- [{ "denominationMinor": "10000", "count": 2 }, …] — evidence; the trigger proves Σ denomination × count = countedMinor
    "denominations"     JSONB NOT NULL,
    "countedMinor"      BIGINT NOT NULL,
    -- the ledger's expected cash at the moment of the count (Σ signed cash_movement rows excluding CLOSING) — the trigger recomputes it
    "expectedMinor"     BIGINT NOT NULL,
    -- counted − expected: negative = SHORTAGE, positive = OVERAGE (measured only: nothing here posts or absorbs it)
    "varianceMinor"     BIGINT NOT NULL,
    "countedByUserId"   UUID NOT NULL,
    "supervisorUserId"  UUID,
    "countedAt"         TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- NO updatedAt (append-only) and NO free-text column

    CONSTRAINT "register_session_count_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "register_session_count_seq_chk" CHECK ("seq" >= 1),
    CONSTRAINT "register_session_count_purpose_chk" CHECK ("purpose" IN ('SPOT', 'CLOSE')),
    CONSTRAINT "register_session_count_currency_shape_chk" CHECK ("currencyCode" ~ '^[A-Z]{3}$'),
    CONSTRAINT "register_session_count_exponent_range_chk" CHECK ("currencyExponent" BETWEEN 0 AND 3),
    CONSTRAINT "register_session_count_counted_chk" CHECK ("countedMinor" >= 0),
    CONSTRAINT "register_session_count_variance_chk" CHECK ("varianceMinor" = "countedMinor" - "expectedMinor"),
    CONSTRAINT "register_session_count_denominations_chk"
      CHECK (jsonb_typeof("denominations") = 'array' AND jsonb_array_length("denominations") <= 64),
    -- a person never verifies their own count
    CONSTRAINT "register_session_count_supervisor_chk"
      CHECK ("supervisorUserId" IS NULL OR "supervisorUserId" <> "countedByUserId")
);

-- immutable history: one row per (session, seq)
CREATE UNIQUE INDEX "register_session_count_session_seq_key"
  ON "register_session_count"("tenantId", "registerSessionId", "seq");
CREATE INDEX "register_session_count_tenantId_branchId_countedAt_idx"
  ON "register_session_count"("tenantId", "branchId", "countedAt");

ALTER TABLE "register_session_count"
  ADD CONSTRAINT "register_session_count_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenant"("id") ON UPDATE CASCADE ON DELETE CASCADE,
  -- proves the count's company / branch / terminal / register AND currency all equal its session's
  ADD CONSTRAINT "register_session_count_session_scope_fkey"
    FOREIGN KEY ("tenantId", "companyId", "branchId", "posTerminalId", "cashRegisterId", "registerSessionId", "currencyCode", "currencyExponent")
    REFERENCES "register_session"("tenantId", "companyId", "branchId", "posTerminalId", "cashRegisterId", "id", "currencyCode", "currencyExponent")
    ON UPDATE NO ACTION ON DELETE NO ACTION,
  ADD CONSTRAINT "register_session_count_counter_fkey"
    FOREIGN KEY ("countedByUserId") REFERENCES "user"("id") ON UPDATE NO ACTION ON DELETE NO ACTION,
  ADD CONSTRAINT "register_session_count_supervisor_fkey"
    FOREIGN KEY ("supervisorUserId") REFERENCES "user"("id") ON UPDATE NO ACTION ON DELETE NO ACTION;

-- ══════════════ the insert guard: lock, state, counter, sequence, expected cash, denominations ══════════════
-- The session row is locked FOR UPDATE: a count serialises with a close (which takes the same lock first) and with other counts; a movement
-- insert (FOR SHARE) waits for a count in flight, so the expected cash read below is exactly the ledger the count is made against.
CREATE FUNCTION fn_register_session_count_guard() RETURNS trigger AS $$
DECLARE
  sess_status   TEXT;
  sess_cashier  UUID;
  prev_seq      INTEGER;
  ledger_sum    BIGINT;
  denom_sum     NUMERIC;
  denom_n       INTEGER;
  denom_distinct INTEGER;
  denom_ok      BOOLEAN;
BEGIN
  SELECT s."status", s."cashierUserId" INTO sess_status, sess_cashier
    FROM "register_session" s
   WHERE s."id" = NEW."registerSessionId" AND s."tenantId" = NEW."tenantId"
     FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'register_session_count: session % not found', NEW."registerSessionId";
  END IF;
  IF sess_status = 'CLOSED' THEN
    RAISE EXCEPTION 'register_session_count: register_session % is CLOSED; no count may be recorded against it', NEW."registerSessionId";
  END IF;
  IF NEW."countedByUserId" <> sess_cashier THEN
    RAISE EXCEPTION 'register_session_count: only the session''s cashier may count (session %)', NEW."registerSessionId";
  END IF;
  -- both users belong to THIS tenant
  IF NOT EXISTS (SELECT 1 FROM "user" u WHERE u."id" = NEW."countedByUserId" AND u."tenantId" = NEW."tenantId")
     OR (NEW."supervisorUserId" IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM "user" u WHERE u."id" = NEW."supervisorUserId" AND u."tenantId" = NEW."tenantId")) THEN
    RAISE EXCEPTION 'register_session_count: a referenced user does not exist in this tenant (session %)', NEW."registerSessionId";
  END IF;

  SELECT coalesce(max(c."seq"), 0) INTO prev_seq
    FROM "register_session_count" c WHERE c."registerSessionId" = NEW."registerSessionId" AND c."tenantId" = NEW."tenantId";
  IF NEW."seq" <> prev_seq + 1 THEN
    RAISE EXCEPTION 'register_session_count: seq must be % (got %)', prev_seq + 1, NEW."seq";
  END IF;

  SELECT coalesce(sum(m."amountMinor"), 0) INTO ledger_sum
    FROM "cash_movement" m
   WHERE m."registerSessionId" = NEW."registerSessionId" AND m."tenantId" = NEW."tenantId" AND m."type" <> 'CLOSING';
  IF NEW."expectedMinor" <> ledger_sum THEN
    RAISE EXCEPTION 'register_session_count: expectedMinor % is not the ledger''s expected cash % (session %)', NEW."expectedMinor", ledger_sum, NEW."registerSessionId";
  END IF;

  SELECT coalesce(sum(d * c), 0), count(*), count(DISTINCT d), coalesce(bool_and(d > 0 AND c >= 0 AND c <= 1000000), true)
    INTO denom_sum, denom_n, denom_distinct, denom_ok
    FROM (SELECT (e ->> 'denominationMinor')::bigint AS d, (e ->> 'count')::bigint AS c
            FROM jsonb_array_elements(NEW."denominations") e) x;
  IF NOT denom_ok OR denom_n <> denom_distinct THEN
    RAISE EXCEPTION 'register_session_count: invalid or duplicate denomination lines (session %)', NEW."registerSessionId";
  END IF;
  IF denom_sum <> NEW."countedMinor" THEN
    RAISE EXCEPTION 'register_session_count: countedMinor % is not the sum of the denomination lines % (session %)', NEW."countedMinor", denom_sum, NEW."registerSessionId";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_register_session_count_guard
  BEFORE INSERT ON "register_session_count"
  FOR EACH ROW EXECUTE FUNCTION fn_register_session_count_guard();

-- append-only: no UPDATE, no DELETE, ever
CREATE FUNCTION fn_register_session_count_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'register_session_count is append-only: % is never permitted (id=%)', TG_OP, OLD."id";
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_register_session_count_append_only
  BEFORE UPDATE OR DELETE ON "register_session_count"
  FOR EACH ROW EXECUTE FUNCTION fn_register_session_count_append_only();

-- ══════════════ the close guard (TODAY's rule — the one trigger a later decision replaces) ══════════════
-- A session may become CLOSED only on its LATEST count, which must be a CLOSE count with NO difference, made against the ledger as it is NOW
-- (a movement recorded after the count makes it stale: recount). The register_session UPDATE already holds the row lock.
CREATE FUNCTION fn_register_session_close_requires_count() RETURNS trigger AS $$
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

CREATE TRIGGER trg_register_session_close_requires_count
  BEFORE UPDATE ON "register_session"
  FOR EACH ROW EXECUTE FUNCTION fn_register_session_close_requires_count();

-- ══════════════ grants + Row-Level Security (same shape as cash_movement) ══════════════
GRANT ALL ON "register_session_count" TO flower_migrate;
REVOKE UPDATE, DELETE ON "register_session_count" FROM flower_platform, flower_app;
GRANT SELECT, INSERT ON "register_session_count" TO flower_platform, flower_app;

ALTER TABLE "register_session_count" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "register_session_count_tenant_branch_isolation" ON "register_session_count"
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
ALTER TABLE "register_session_count" FORCE ROW LEVEL SECURITY;
