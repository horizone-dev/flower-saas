# HG3b-SALE-LATENCY — staging dataset seeding plan and safe benchmark procedure (**PLAN — nothing here has been run on any staging environment**)

- **Status:** a plan for owner approval. **No seeding tool exists yet, no staging environment exists, no staging result exists.** Nothing below is a
  measured claim about staging; every figure is either a specification already in `HG3B-SALE-LATENCY-ENVIRONMENT-SPEC.md` or labelled as
  unmeasured.
- **Unchanged and preserved:** the load-driver safety limits (`ALLOW_FINANCIAL_WRITES=yes`, https-or-localhost, typed `CONFIRM_TARGET_HOST`,
  `MAX_DOCUMENTS`, `DRY_RUN`) and the **PROPOSED, NOT APPROVED** thresholds (p95 ≤ 1 s, p99 ≤ 2 s, ≥ 3 sales/s/company).

## 1. What must exist, and what already does

| Need                                                               | Exists today                                                                                                                                                                                                     | Gap                                                                                    |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Drive real sales through the real HTTP API                         | `apps/api/src/staging-benchmark/` (verified against the real API by a compatibility test)                                                                                                                        | independent review; never run remotely                                                 |
| Post-run correctness SQL                                           | `HG3B-SALE-LATENCY-POST-RUN-CHECKS.sql` (each statement executed by a test)                                                                                                                                      | outbox expectation undefined (informational only)                                      |
| A ledger of realistic volume (D1: 25 000 documents / 90 days)      | `verification/load-sales-fixture.ts` — a **set-based, direct-SQL** generator (`seedReferenceRows`, `seedSalesCompany`, `fingerprintOrders`) that takes any `pg` connection; used by the Checkpoint G dense tests | **no CLI**: it is only called from vitest against Testcontainers; no remote safeguards |
| Tenants / companies / catalogue / prices / users for the benchmark | the public provisioning and catalogue routes (used by `createSaleWorld` in tests)                                                                                                                                | no script that drives them against a remote deployment                                 |
| Snapshot / restore of a known dataset                              | —                                                                                                                                                                                                                | a procedure (provider-specific) and a checksum method (§5)                             |

## 2. Datasets (as specified in the environment spec §3 — unchanged)

| Id  | Shape                                                                                                                             | How it is built (§3)                                                   |
| --- | --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| D0  | 1 tenant, 1 company, 1 branch (+ a second branch for isolation checks), 50 products, 5 000 customers, empty ledger                | API provisioning (layer A) + customers via API or a bounded SQL loader |
| D1  | D0 + **25 000 issued documents inside a 90-day window** for the benchmark company (the frozen `REPORT_RESULT_TOO_LARGE` boundary) | layer B (set-based SQL fixture, the benchmark company only)            |
| D2  | 20 companies across 5 tenants, each D0 scale                                                                                      | API provisioning × 20 (layer A), scripted                              |
| D3  | D1 plus concurrent report readers (Trial Balance, Sales, Tender Totals, Receivables) while selling                                | D1 + the driver's `REPORT_READERS`                                     |

## 3. The approach, by layer — and why

**Layer A — real structure through the real API (D0, D2, the benchmark company in D1).** Tenants, companies, branches, users, tax, catalogue, prices and
the accounting configuration are created by the **public provisioning / catalogue routes**, so every rule the production code enforces is exercised
and nothing is shortcut. These are few objects; speed does not matter. _Reuse:_ the call sequence of `createSaleWorld`
(`load-sale-world.ts`) is the executable specification; a remote provisioning script is a new, small, reviewed task.

**Layer B — ledger volume by set-based SQL (D1 only).** 25 000 documents through the HTTP API at the local serialisation ceiling (~8–9 sales/s/company,
a LOCAL figure) would take on the order of an hour **per rebuild** and could not place documents across a 90-day window (the API stamps the current
date). The existing fixture already builds, set-based and in bounded batches, a **valid** history: issued orders with a correct commercial fingerprint,
coherent invoices, sealed balanced sale journals, spread over exactly 90 days and several branches. It is **explicitly disposable-data tooling** and
was verified against the frozen boundary over HTTP (25 000 accepted, one more → 422, 91 days → 400). _What a new CLI wrapper must add:_

1. **Refuse to run unless** `ALLOW_BENCHMARK_SEED=yes`; the target host name is typed in `CONFIRM_DB_HOST` and equals the connection's host; and the
   target database carries an explicit **benchmark marker** (a row the operator created, e.g. `benchmark_environment.name = '<env>'`) — a production
   database never has it.
2. **Never touch existing data:** insert only under tenant ids with a reserved prefix (the fixture uses `gs-`), refuse a non-empty prefix unless
   `--rebuild` is given, and never `DELETE`/`TRUNCATE` outside that prefix.
3. **Print a plan first** (`DRY_RUN=yes`: rows per table, batches, estimated bytes) and **record a fingerprint after** (§5).
4. Connect with the **migration-owner role supplied by the owner for the benchmark database only** (the loader needs to bypass RLS to insert
   set-based); credentials via environment, never logged (the project's safe-logging rules apply).

**What layer B does NOT prove:** the seeded history bypasses the application's posting path, so it proves **ledger-volume behaviour** (report latency,
index depth, sale latency over a large table) — **not** posting correctness (that is the sales' own tests, and the driver's real-API sales).
This limit must be stated in the benchmark report.

## 4. Safe benchmark procedure (end to end)

| #   | Step                                                                                                                                                                   | Evidence archived                             |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| 0   | **Approvals in writing:** environment, criteria (incl. the T2 measurement point), operator, seeding tool, driver review (spec §11)                                     | the approvals                                 |
| 1   | **Freeze the build:** the git SHA the closure branch's own CI verified; image digest; migration set (50); configuration; PostgreSQL / PgBouncer parameters; `shm_size` | build record                                  |
| 2   | **Provision** the environment of spec §2 on separate hosts; observability on (`pg_stat_statements`, lock waits, deadlocks, pool, host metrics)                         | environment record                            |
| 3   | **Layer A**, then **layer B** with `DRY_RUN` first; `ANALYZE`                                                                                                          | plan, row counts                              |
| 4   | **Fingerprint and snapshot** the dataset (§5); rehearse a restore once                                                                                                 | fingerprint, snapshot id                      |
| 5   | **Driver dry-run:** `DRY_RUN=yes` prints the plan and sends nothing                                                                                                    | plan output                                   |
| 6   | **Warm-up** (`WARMUP_S`) at the scenario's rate — discarded                                                                                                            | —                                             |
| 7   | **Measured run** (S1 → S4 per spec §4), open-loop, `MAX_DOCUMENTS` sized for the campaign; reports readers for S4                                                      | `run-<scenario>-<n>.json`, raw server metrics |
| 8   | **Post-run checks** (`POST-RUN-CHECKS.sql`) — PASS/FAIL; any failure or any 40P01 stops the campaign                                                                   | SQL output                                    |
| 9   | **Restore** the snapshot before the next repetition (≥ 3 per scenario); re-fingerprint and compare                                                                     | fingerprint match                             |
| 10  | **Report every repetition** against the _approved_ criteria; a failed run is reported and diagnosed, never discarded; no criterion is changed after seeing a result    | the report of spec §6                         |
| 11  | **S5 failure injection** (PgBouncer saturation, PostgreSQL restart) while the driver runs, then step 8                                                                 | fault log + SQL output                        |
| 12  | **Teardown:** rotate the benchmark token and credentials; destroy or archive the environment per the owner's policy                                                    | teardown record                               |

**Stop conditions (unchanged):** any correctness failure, any deadlock, error rate above the approved bound, any non-zero `droppedByCap`, any
indication the target is not the benchmark environment.

## 5. Dataset fingerprint (so "restored to a known dataset" is checkable)

A deterministic, order-independent fingerprint per dataset, computed in SQL after seeding and after every restore, and compared:

```sql
-- per benchmark company (psql -v company_id=…); the same statement before and after a restore must return identical values
SELECT (SELECT count(*) FROM invoice WHERE "companyId" = :'company_id')                                   AS invoices,
       (SELECT COALESCE(sum("totalAmountMinor"), 0) FROM invoice WHERE "companyId" = :'company_id')::text AS invoiced_total_minor,
       (SELECT count(*) FROM journal_entry WHERE "companyId" = :'company_id')                             AS journals,
       (SELECT COALESCE(sum(jl."debitMinor"), 0) FROM journal_line jl WHERE jl."companyId" = :'company_id')::text AS journal_debits_minor,
       (SELECT count(*) FROM "order" WHERE "companyId" = :'company_id')                                    AS orders,
       (SELECT count(*) FROM payment WHERE "companyId" = :'company_id')                                    AS payments,
       (SELECT max("invoiceNumber") FROM invoice WHERE "companyId" = :'company_id')                        AS last_invoice_number;
```

_(Not yet executed against any seeded dataset; to be validated by the seeding task's own tests.)_ A byte-level checksum of a logical dump is an
optional stronger check, provider permitting.

## 6. What still has to be built or provided (the honest list)

1. **A seeding CLI wrapper** around the existing fixture with the §3 safeguards, **its tests**, and an **independent review** — small, but it writes
   directly to a database and must be reviewed like the driver.
2. **A remote provisioning script** for layer A (the `createSaleWorld` call sequence against a deployment), and the D2 many-company variant.
3. **The staging environment**, its snapshot/restore mechanism, and the observability stack.
4. **The owner inputs** (spec §11): demand, approved criteria in writing, operator and schedule.
5. **A CI-verified build** of the closure branch (blocked until the branch is pushed with approval).

**Estimated effort and elapsed times are deliberately not stated: none has been measured, and a local number would not describe a staging database.**

## 7. Implementation plan (for approval — nothing below is built)

### 7.1 Where it lives, and why

`apps/api/src/verification/staging-seed/` — **not** `staging-benchmark/` (a structural test forbids any database access in the driver's directory, which is the
point of keeping the driver a pure HTTP client) and **not** a new package (the existing fixture is in `verification/`, and importing across a package boundary would
violate the dependency-boundaries lint rule). It is never imported by the application. If the owner prefers a `tooling/` location, the fixture must first move to a
shared package.

### 7.2 Tasks, each with its acceptance test

| #   | Task                                                                                                                                                                                                                                                    | Acceptance                                                                                                                                                                                                               |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| S-1 | `seed-safeguards.ts` (pure): `ALLOW_BENCHMARK_SEED=yes`; typed `CONFIRM_DB_HOST` equals the connection host; a **benchmark marker row** exists (created by the operator, never by the tool); a reserved tenant-id prefix; a row ceiling; `DRY_RUN`      | unit tests for **every** refusal path and the passing path; **mutation-tested** like the driver's safeguards                                                                                                             |
| S-2 | `seed-cli.ts`: connects with the benchmark-database owner role supplied for that database only (credentials by environment, never logged); runs `seedReferenceRows` + `seedSalesCompany` in bounded batches; prints the plan, then the fingerprint (§5) | an integration test against a Testcontainers database **with** the marker checks exact row counts; it **refuses** without the marker, with a wrong host, without the flag, and on a non-empty prefix without `--rebuild` |
| S-3 | **Marker procedure** (documentation + a SQL snippet the operator runs): a one-row `benchmark_environment` table — a DDL the tool deliberately does **not** run                                                                                          | reviewed by the owner; a production database never has it                                                                                                                                                                |
| S-4 | **Layer A provisioning script** against a remote deployment: the call sequence of `createSaleWorld` (platform token → tenant / company / branches / users → tax, catalogue, prices → accounting configuration)                                          | its own integration test provisions a Testcontainers deployment over HTTP, then runs the **driver's** dry-run and a 5-sale smoke against it                                                                              |
| S-5 | Fingerprint runner: executes the §5 statement before / after seeding and after every restore, and **compares**                                                                                                                                          | unit test of the comparison; integration test that a changed row changes the fingerprint                                                                                                                                 |
| S-6 | Dense-boundary regression: seeded D1 is accepted by the Sales report at exactly 25,000 documents, **one more is rejected**, 91 days is rejected (the existing Checkpoint G drift guard, reused)                                                         | the existing dense-window assertions, run against the seeded database                                                                                                                                                    |
| S-7 | **Independent review** of S-1…S-6 by someone other than the author                                                                                                                                                                                      | written review                                                                                                                                                                                                           |
| S-8 | Rehearsal: `DRY_RUN=yes` against the real staging database, then the real seed, then the fingerprint and a restore rehearsal                                                                                                                            | owner-witnessed; fingerprint equal after restore                                                                                                                                                                         |

### 7.3 Facts about the existing fixture that change the benchmark design (read from its code)

1. **It creates no payments.** Per document it writes an issued order, its lines, a coherent invoice and a **sealed, balanced sale journal** — **no `payment` and no
   `payment_allocation` rows.** Seeded history therefore proves ledger-volume behaviour for sales and the Sales / Trial Balance reports only; it does **not**
   exercise Tender Totals. Tender needs payments: extend the fixture (a reviewed change) or drive them through the API (slow) — **an owner decision**.
2. **Post-run check 4** of `HG3B-SALE-LATENCY-POST-RUN-CHECKS.sql` ("exactly one payment allocation per invoice") **would flag every seeded invoice**. It must be
   scoped to invoices issued **during the run**; checks 2 and 3 are valid on all invoices. The scoped form (**not yet executed against any database**):

   ```sql
   -- psql -v company_id=... -v since='<run start, recorded before the first request>'
   SELECT i.id FROM invoice i LEFT JOIN payment_allocation pa ON pa."invoiceId" = i.id
    WHERE i."companyId" = :'company_id' AND i."issuedAt" >= :'since'::timestamptz
    GROUP BY i.id HAVING count(pa.id) <> 1;
   ```

3. **It bypasses the application's posting path** — it proves volume, not correctness (as stated in §3).
4. **Dates:** documents are spread over 90 days from a fixed start; the benchmark's own sales are stamped with the current date, so the run window must fall
   **inside** an open accounting period of the seeded company. S-8 must check this.
5. **RB-1:** seeded history contains **no anonymous credit notes**; the refund workload of the decision sheet needs credit notes created through the API during the
   run, and the summary's integrity gate must be run afterwards.

### 7.4 What this plan deliberately does not do

It does not choose the workload, the criteria or the environment (the owner's: `HG3B-PERFORMANCE-DECISION-SHEET.md`), does not estimate seeding time, and does
not touch any database.
