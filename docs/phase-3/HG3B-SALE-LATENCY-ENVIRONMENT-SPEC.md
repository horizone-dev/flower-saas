# HG3b-SALE-LATENCY — required environment, dataset and benchmark criteria (SPECIFICATION, no results)

- **Status:** specification for the owner to approve, prepared 2026-11-11. **Sections 1–6 are specification only; section 7 records LOCAL readings with their provenance (not representative); section 9 contains PROPOSED targets that are NOT approved.** The gate stays **OPEN** until a representative environment exists, the owner approves the criteria in §5, and the runs in §4
  pass them. Nothing here was run on a production-like system.
- **Gate text (PHASE-3B-PLAN §G):** "re-measure the atomic-sale transaction and company document-counter latency under a
  representative environment. The Task 3b.9 Checkpoint C figure (7–11 sales/s/company) is a non-production benchmark from a local
  test container, NOT a capacity guarantee."

## 1. What can and cannot be measured safely on a developer machine

| Benchmark                                                                                              | Where it lives                                                                                                                               | Safe locally?                                                             | What it proves                                                                                        |
| ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Atomic-sale counter-lock measurement                                                                   | `modules/sales/atomic-walk-in-sale.integration.test.ts` → `MEASURE the company document-counter lock…` (writes `SALE_METRICS_FILE` when set) | **Yes** (one Testcontainers PostgreSQL; run alone)                        | correctness under serialisation + an observation of per-company throughput. **Not** a capacity claim  |
| Report density / query-plan tests (25 000 documents, 90 days)                                          | `modules/reporting/*.dense-window.*`, `*.query-plan.*`                                                                                       | Yes (they ran green in this closure)                                      | plan shape and growth, local                                                                          |
| Checkpoint G opt-in load (`G_LOAD=1`: 100 000-record HTTP worlds, mixed read/write, sales concurrency) | `verification/task-3b10-checkpoint-g-*.test.ts`                                                                                              | **No** — it was memory-reaped on this machine before and is frozen/merged | already recorded in decision `3b.10-GL`/`GR`/`GF`; re-running locally adds no representative evidence |
| Anything involving PgBouncer, managed PostgreSQL, network latency, real CPU/RAM sizing                 | —                                                                                                                                            | **No**                                                                    | needs the staging environment below                                                                   |

## 2. Required environment (to be provided; sizes are the owner's decision)

1. **Topology equal to production's intended shape:** API process(es) (`api` role), PostgreSQL 17 (managed or self-hosted as in
   production), Redis, **PgBouncer in the pooling mode ADR-0010 specifies**, the same Node 24 build, the production container limits.
2. **PostgreSQL shared memory:** `/dev/shm` / `shm_size` of **512 MB** is the recorded _candidate_ (decision `3b.10-GS`; 64 MB failed
   concurrent Trial Balance reads with `53100`). It must be validated here, not assumed. `max_parallel_workers_per_gather = 0` is the
   verified safe setting today.
3. **Network:** load generator on a separate host from the API; database not on the API host.
4. **Observability during runs:** PostgreSQL `pg_stat_statements`, lock waits (`pg_locks`, `log_lock_waits`), deadlock count,
   connection counts at PgBouncer and PostgreSQL, CPU / memory / IO of every host, API error log.
5. **Isolation:** a dedicated database restored to a known dataset before every run; no other tenant traffic.
6. **Unresolved sizing inputs (owner to state):** target concurrent registers per company, companies per tenant, tenants per cluster,
   peak sales/day, expected report usage while selling.

## 3. Datasets

| Dataset              | Shape                                                                                                                                                              | Why                                                                                                                            |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| D0 baseline          | 1 tenant, 1 company, 1 branch, 50 products, 5 000 customers, empty ledger                                                                                          | cold-start sale path                                                                                                           |
| D1 busy company      | D0 + a ledger at the frozen reporting boundary: **25 000 issued documents inside the 90-day window** for the company (the frozen `REPORT_RESULT_TOO_LARGE` limits) | latency of a sale while the ledger is at its supported size                                                                    |
| D2 many companies    | 20 companies across 5 tenants, each at D0 scale                                                                                                                    | proves the per-company serialisation does not spill across companies                                                           |
| D3 reporting overlap | D1 plus concurrent readers of Trial Balance, Sales, Tender Totals, Receivables                                                                                     | the carried-forward observation (≈ 4.2× POS write p95 degradation with ten concurrent readers, local) must be re-measured here |

Data must be generated by the existing deterministic generators (`verification/load-sale-world.ts`, `load-sales-fixture.ts`), not by hand,
so the figures are reproducible.

## 4. Scenarios (each run ≥ 3 times, after a recorded warm-up; report every run, not the best)

1. **S1 sequential:** one register, back-to-back anonymous PAY_NOW cash sales, then identified-customer PAY_NOW and ON_CREDIT.
2. **S2 same-company concurrency:** N ∈ {1, 2, 4, 8, 16} simultaneous sales in ONE company (counter-lock contention).
3. **S3 multi-company:** the same N across 1, 4, 16 companies at once.
4. **S4 mixed:** S2 at the owner-approved N while 1, 2, 5, 10 report readers run.
5. **S5 failure injection:** the same load with PgBouncer saturation and with a PostgreSQL restart mid-run (every in-flight sale must
   either commit whole or roll back whole, no duplicate number, no orphan journal).

**Metrics per scenario:** sale latency p50 / p95 / p99 / max (end-to-end HTTP), counter-lock wait and hold times, sales/s per company and
overall, error rate by status, `40P01`/`40001`/`55P03` counts, pool wait time, CPU/IO of each host. **Correctness assertions during the
runs (not optional):** invoice numbers gapless per company, one journal per sale, journals balanced, no duplicate sale on retry.

## 5. Acceptance criteria — **OWNER TO DEFINE**

No criteria have been approved. The only recorded proposal (memory of the 3b.11 discovery, **proposed, not approved**) was
_p95 ≤ 1 s, p99 ≤ 2 s, ≥ 3 sales/s/company_. It must be accepted, changed or replaced by the owner **before** any run is judged; a
run's result must never be used to set its own target. Also to be decided: the maximum acceptable write-latency degradation under
concurrent reporting (S4), and whether S5 outcomes are pass/fail or informational.

## 6. Deliverable when the gate is run

A report with: environment description and sizes, dataset checksums, every run's raw metrics, the criteria used and who approved them,
pass/fail per criterion, any anomaly, and the PostgreSQL/PgBouncer configuration. Only then may `HG3b-SALE-LATENCY` be marked satisfied.

---

## 7. Provenance of the local readings (verified 2026-11-11 — LOCAL, NOT REPRESENTATIVE, NOT AN ACCEPTANCE RESULT)

- **Machine:** Intel Core i5-6500 @ 3.20 GHz, 4 cores / 4 threads, 16 GB RAM, Windows 10 Pro 19045; Docker Desktop (server 29.8.2) with an 8 GB / 4-CPU VM running a single `postgres:17` Testcontainers instance; Node 24.20.0; one vitest worker; other desktop applications were running (this is not an isolated host).
- **Code:** `origin/main` `ea56cff` plus the uncommitted closure-hardening changes (they do not touch the sale path, the journal or numbering).
- **Test:** `modules/sales/atomic-walk-in-sale.integration.test.ts` → `MEASURE the company document-counter lock: one company serialises, many companies do not (correctness-only serialisation)`; figures are written by the test itself when `SALE_METRICS_FILE` is set. Its assertions are correctness-only (gapless numbers); **performance is measured, not gated**.
- **Command:** `SALE_METRICS_FILE=<file> pnpm exec vitest run src/modules/sales/atomic-walk-in-sale.integration.test.ts -t "MEASURE the company document-counter lock" --no-file-parallelism --maxWorkers=1`.

| Reading                                       | Sequential per-sale median | Sequential counter-hold median | 16 sales, ONE company: wall / hold median / hold p95 | 16 sales across FOUR companies: wall | Implied sales/s/company |
| --------------------------------------------- | -------------------------- | ------------------------------ | ---------------------------------------------------- | ------------------------------------ | ----------------------- |
| A (by-product of the full `sales` batch)      | 131 ms                     | 113 ms                         | 1,654 ms / 757 ms / 1,601 ms                         | 715 ms                               | 9                       |
| B (single-test run 1)                         | 164 ms                     | 131 ms                         | 2,274 ms / 911 ms / 2,190 ms                         | 790 ms                               | 8                       |
| C (single-test run 2)                         | 139 ms                     | 111 ms                         | 1,804 ms / 904 ms / 1,638 ms                         | 585 ms                               | 9                       |
| D (single-test run 3)                         | 152 ms                     | 115 ms                         | 2,146 ms / 955 ms / 2,042 ms                         | 670 ms                               | 9                       |
| **Range (4 readings)**                        | **131–164 ms**             | **111–131 ms**                 | **1,654–2,274 ms / 757–955 ms / 1,601–2,190 ms**     | **585–790 ms**                       | **8–9**                 |
| Earlier recorded (`TASK-3B9-PLAN.md`, 3 runs) | 122–138 ms                 | 93–113 ms                      | 1,796–2,026 ms / 786–1,048 ms / 1,524–1,915 ms       | 624–733 ms                           | 9–11                    |

The two sets agree. What they show: same-company sales serialise on the company document-counter lock, so throughput per company is bounded by
the lock hold (≈ 110–130 ms here ⇒ ≈ 8–9 sales/s); 16 simultaneous sales in one company finish in ≈ 1.7–2.3 s (the last waits for the other
15); different companies do not contend (four companies ≈ 0.6–0.8 s). Variation between runs is ≈ ±15 %. **None of this is a capacity claim for
production:** a Docker VM on a desktop, no network, no PgBouncer, no concurrent tenants, no TLS, a 4-core CPU shared with other applications.

## 8. Staging benchmark RUNBOOK

**Preconditions (all must be true before the first run):** the environment of §2 exists; the owner has approved the criteria of §5 (or the
proposal of §9); a load driver exists (see "Gap" below); the dataset restore procedure is rehearsed; observability of §2.4 is collecting.

**Load driver — now exists locally, NOT yet run against any staging environment.** `apps/api/src/staging-benchmark/` (`driver-core.ts`,
`sale-driver.ts`, `safeguards.ts`, `cli.ts`; 19 unit tests in `staging-benchmark.test.ts` and 1 real-HTTP compatibility test) drives the real HTTP API (create order → totals →
`complete-sale` with PAY_NOW CASH, one fresh `Idempotency-Key` per sale) with an **open-loop** arrival schedule, a counted in-flight cap
(dropped arrivals are reported, never silently queued), a discarded warm-up window, and optional **concurrent report readers** (S4). Its
unit tests prove the arithmetic, the control flow and the pre-flight safeguards against an injected fake transport; **a compatibility test
(`staging-benchmark.compat.integration.test.ts`) runs the real driver with the real `fetch` over a real socket against the real application
and proves the request sequence and contract are correct** (every scheduled sale completed with 200, readers answered 200, and the SQL
post-run checks of `HG3B-SALE-LATENCY-POST-RUN-CHECKS.sql` hold). Neither says **anything** about any real system's latency. Mutation check:
5 mutants of the safeguards (host confirmation, document ceiling, warm-up counted, opt-in, https) are all caught. It has had no
independent review — that is still required before it is used for the gate. See §8.1 for how to run it.

**Procedure**

1. **Freeze the build:** record the git SHA, image digest, config, PostgreSQL/PgBouncer parameters, `max_parallel_workers_per_gather`, `shm_size`.
2. **Restore the dataset** (D0, D1, D2 or D3 of §3) from the same snapshot; record its checksum; run `ANALYZE`; reset `pg_stat_statements`.
3. **Warm up:** 5 minutes of the scenario at half load; discard.
4. **Run each scenario of §4** at the approved load for ≥ 10 minutes (S2/S3) with an OPEN-loop arrival model (fixed arrival rate, not "as fast as possible"), ≥ 3 repetitions, restoring the dataset between repetitions.
5. **During every run** collect: client-side latency histogram per request (HTTP), server-side timings, lock waits and deadlocks, pool saturation, host CPU/IO.
6. **After every run** execute `docs/phase-3/HG3B-SALE-LATENCY-POST-RUN-CHECKS.sql`: invoice numbers gapless per company; exactly one `walk_in_sale` journal per issued invoice; every journal balanced; exactly one payment allocation per invoice (no duplicate sale). The outbox event set is **informational only** until the exact expected events are stated (a single-tender sale is documented to emit no `orders.sale_completed`, so the earlier wording "one outbox event per sale" was not a verifiable assertion). Customer-linked (ON_CREDIT / identified) sales are not covered by the driver or these checks.
7. **Report** every repetition (not the best), the criteria in force, pass/fail per criterion, and the raw files. A failed run is reported and diagnosed, never discarded.
8. **Stop conditions:** any correctness failure, any 40P01, or error rate above the approved bound ends the run and is a gate failure.

### 8.1 Running the driver (staging only)

```
pnpm --filter @flower/api build
ALLOW_FINANCIAL_WRITES=yes BASE_URL=https://<staging-host> CONFIRM_TARGET_HOST=<staging-host> \
  TOKEN=<owner-or-manager session token> COMPANY_ID=… BRANCH_ID=… PRODUCT_ID=… VARIANT_ID=… [UOM_CODE=piece QUANTITY=1] \
  RATE=3 DURATION_S=600 WARMUP_S=300 [MAX_IN_FLIGHT=200] [MAX_DOCUMENTS=20000] \
  [REPORT_READERS=10 REPORT_PATHS=/companies/<id>/reports/…?…,… READER_INTERVAL_MS=250] \
  DRY_RUN=yes node apps/api/dist/staging-benchmark/cli.js            # 1) prints the plan, SENDS NOTHING
  # then the same command WITHOUT DRY_RUN=yes, redirected:  > run-<n>.json
```

(Report paths are relative to `/v1`, e.g. `/companies/<id>/reports/trial-balance?from=YYYY-MM-DD&to=YYYY-MM-DD`; a reader needs the report
permissions, so the owner token is the simple choice.)

- **Safety (all enforced by `safeguards.ts` BEFORE any request, each mutation-tested):** it **creates real orders, invoices, payments and
  journal entries**. It refuses to start unless (1) `ALLOW_FINANCIAL_WRITES=yes`; (2) `BASE_URL` is https (http only for localhost);
  (3) `CONFIRM_TARGET_HOST` — typed by the operator — **equals the target's host name** (a pasted or mistyped production URL cannot be
  benchmarked by accident); (4) the run, warm-up included, creates at most `MAX_DOCUMENTS` sales (default 20 000); (5) every numeric
  parameter is positive. `DRY_RUN=yes` prints the plan and sends nothing. The token is never printed. **It remains the operator's
  responsibility that the target is a dedicated benchmark environment — the host confirmation proves intent, not that the host is not
  production.** It must never be pointed at production or at a tenant holding real data.
- **Output:** one JSON document (scheduled / completed / failed / dropped-by-cap sales, achieved sales per second, latency summaries
  for end-to-end and for each of the create / totals / complete steps and for the report readers, and an error histogram keyed
  `step:status:code`) and a **PROVISIONAL** evaluation against `p95 ≤ 1 s`, `p99 ≤ 2 s`, `≥ 3 sales/s/company`
  that carries a notice that these thresholds are **not approved release criteria**. Exit code 0 means "the run completed", never "the gate
  passed"; 2 means misconfiguration.
- **Not covered by the driver** (still to be done by the procedure above): the §8 step 6 correctness checks are SQL
  (`HG3B-SALE-LATENCY-POST-RUN-CHECKS.sql`) to run **after** each repetition; failure injection (S5); the burst (T3) and multi-company (T4)
  scenarios (run the driver against several companies in parallel processes); dataset restore between repetitions; and **dataset seeding**
  (see §8.2 — the deterministic generators named in §3 are in-process vitest harnesses and cannot seed a remote database).
- **Workload assumptions baked into the driver (change them deliberately):** one single-line CASH sale per arrival, one product/variant, no
  customer, no discount, no tax-inclusive variant, one tenant/company/branch per process, one session token. A different mix (multi-line,
  card, taxed, customer-linked, BOM) needs a different scenario and its own evidence.
- **Infrastructure and evidence still missing** (none of this exists today): the §2 staging environment with production-like PostgreSQL
  (and PgBouncer if used), a seeded dataset (§3), server-side observability (§2.4), the approved criteria (§5/§9), an independent driver
  review, and ≥ 3 recorded repetitions per scenario. **No staging capacity, throughput or latency claim may be made from any local number.**

### 8.2 What the driver covers of §4, and the exact staging checklist

| Scenario                                | Driver coverage                                                                  | Still needed                                                                                                   |
| --------------------------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| S1 sequential, anonymous PAY_NOW cash   | yes (`RATE` low, e.g. 1)                                                         | identified-customer PAY_NOW / ON_CREDIT are **not** supported                                                  |
| S2 same-company concurrency (N at once) | approximated by open-loop rate and `MAX_IN_FLIGHT`; no true N-simultaneous burst | a burst mode if T3 (16 simultaneous) is to be judged                                                           |
| S3 multi-company                        | one process per company, run in parallel                                         | orchestration by the operator; one token per company                                                           |
| S4 mixed (sales + report readers)       | yes (`REPORT_READERS`, `REPORT_PATHS`)                                           | owner-approved N and reader counts                                                                             |
| S5 failure injection                    | **no**                                                                           | external fault injection (PgBouncer saturation, PostgreSQL restart) while the driver runs, then the SQL checks |

**Staging checklist — every item must be checked off and its evidence archived before a run is judged (none exists today):**

1. [ ] Environment of §2 provisioned: API role(s), PostgreSQL 17 (managed or as production), Redis, PgBouncer in the ADR-0010 pooling mode, same Node 24 build and container limits as production; **load generator on a separate host in the same region class**; database not on the API host.
2. [ ] `shm_size` 512 MB validated (not assumed) with concurrent Trial Balance reads; `max_parallel_workers_per_gather = 0`; PostgreSQL / PgBouncer parameters recorded.
3. [ ] Build frozen: git SHA **that closure-branch CI verified**, image digest, config, migration set (50 migrations).
4. [ ] Dedicated database, no other tenant traffic; dataset D0 / D1 / D2 / D3 (§3) **seeded** — requires seeding tooling that **does not exist yet** (the generators in `verification/load-sale-world.ts` and `load-sales-fixture.ts` run in-process against Testcontainers). D1 needs 25 000 issued documents inside a 90-day window. Dataset snapshot + checksum recorded; restore procedure rehearsed.
5. [ ] One benchmark tenant/company/branch per driven company with a priced, activated product/variant, a taxed or untaxed configuration stated in the report, and an **owner-role token** with report permissions; token rotated after the campaign.
6. [ ] Observability on (§2.4): `pg_stat_statements` (reset before each run), `log_lock_waits`, deadlock counter, connection counts at PgBouncer and PostgreSQL, CPU / memory / IO of every host, API error log.
7. [ ] `ANALYZE` run; warm-up configured (`WARMUP_S`); `MAX_DOCUMENTS` sized for the campaign.
8. [ ] Criteria of §5 approved **in writing before the first run** (§9, §11), including how T2 is measured (§9.1).
9. [ ] Driver reviewed by someone other than its author.
10. [ ] Execution: `DRY_RUN=yes` first; then the real command of §8.1; archive `run-<n>.json`, the raw server metrics and the output of `HG3B-SALE-LATENCY-POST-RUN-CHECKS.sql` for **every** repetition (≥ 3 per scenario, dataset restored between repetitions).
11. [ ] Report assembled per §6 and signed off against the approved criteria; any failed run reported and diagnosed, never discarded.

## 9. PROPOSED acceptance targets — **PROPOSED, NOT APPROVED** (for the owner to accept, change or replace)

These are derived only from the repository's own local evidence (§7) and carry no staging authority. They must not be used to judge a run
until approved, and a run must never be used to set its own target.

| #   | Criterion                                   | Proposed target                                                                    | Basis (evidence-based, and its limits)                                                                                                                                                                                                                  |
| --- | ------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T1  | Sustained throughput, ONE company           | ≥ 3 sales/s sustained for 10 min, error rate 0                                     | ≈ one third of the local serialisation ceiling (8–9 sales/s), leaving room for network and pooler latency inside the counter-lock hold; the earlier proposal also said 3                                                                                |
| T2  | Latency at the T1 load, end-to-end HTTP     | p95 ≤ 1.0 s; p99 ≤ 2.0 s                                                           | local sequential median is 131–164 ms; at 3 sales/s the counter lock is ≈ 35 % utilised (3 × 0.12 s), so queueing should be small; the targets keep ≈ 6× margin over the local median                                                                   |
| T3  | Burst: 16 simultaneous sales in ONE company | p95 ≤ 3.0 s (**informational**)                                                    | local 16-way hold p95 is 1.6–2.2 s; allows ≈ 1.5× for network; a burst this large is not an expected steady state                                                                                                                                       |
| T4  | 16 sales across FOUR companies              | wall ≤ 1.0 s (**informational**)                                                   | local 0.6–0.8 s; proves cross-company independence                                                                                                                                                                                                      |
| T5  | Correctness (binary, no tolerance)          | 0 gaps, 0 duplicates, 0 unbalanced journals, 0 deadlocks (40P01), 0 unexpected 5xx | the frozen sale contract; these are pass/fail                                                                                                                                                                                                           |
| T6  | Failure injection (S5)                      | every in-flight sale commits whole or rolls back whole                             | frozen atomicity gate                                                                                                                                                                                                                                   |
| T7  | Sales write latency while reports run (S4)  | **owner to decide** — no target proposed                                           | the only evidence is a local ≈ 4.2× POS-write p95 degradation under ten concurrent readers (3b.10); a "2×" target would very likely fail and would then require a design change (read replica or separate pool) — that is a decision, not a tuning knob |

**Demand input still needed from the owner:** expected peak sales/s per company and registers per company. The target T1 should be at least a
stated safety factor above that peak; the current "3 sales/s" is a placeholder, not a business-derived number (for orientation only: ten
registers each selling once every 20 s is 0.5 sales/s).

### 9.1 Review of the proposed thresholds (methodological — does not approve them)

1. **T2 is ambiguous about what is timed.** The driver's headline figure is `endToEnd` = **three sequential requests** (create order → totals →
   complete-sale). The local evidence behind the targets (median 131–164 ms, counter-lock hold 111–131 ms) is the **sale transaction itself**
   (`complete-sale`). The report also gives `complete` separately. The owner must state which one is the criterion: the lock-bound
   `complete` step is the one the serialisation analysis supports; the three-request figure additionally depends on two cheap reads. Recommended:
   judge **`complete` p95 / p99** against T2 and report `endToEnd` alongside; do not apply the same numbers to both without a decision.
2. **T1 as written is not a capacity measurement.** An open-loop run at 3 sales/s with zero errors and zero drops shows the system **keeps up
   at 3/s**; it does not locate the saturation point. Add an informational **step ladder** (the same driver at RATE = 1, 2, 3, 5, 8, 12) to find the
   knee; the local serialisation ceiling (≈ 8–9/s) is a local figure only.
3. **3 sales/s is a placeholder, not a business number.** For orientation, ten registers selling once every 20 s is 0.5 sales/s. The target
   should be a stated safety factor above the owner's peak demand (§9 "Demand input").
4. **Statistical sufficiency:** at 3/s for 600 s a run has 1 800 sales, so p99 rests on the 18 slowest; p99.9 is not meaningful. Three
   repetitions are the minimum for spread; report all, judge on the worst (not the best) and not on a pooled average.
5. **Coordinated omission is handled** (latency is measured from the **scheduled** arrival, and a saturated target never slows arrivals —
   surplus arrivals are dropped and counted), but any non-zero `droppedByCap` must be treated as a failed run, not a footnote.
6. **Zero-tolerance items (T5) are right as stated** (they are the frozen sale contract); the correctness SQL of
   `HG3B-SALE-LATENCY-POST-RUN-CHECKS.sql` implements them, except the outbox expectation (see §8 step 6).
7. **T7 stays an owner decision** (≈ 4.2× local write degradation under ten readers is the only evidence; a 2× target would very likely fail
   and would then need a design change — read replica or separate pool — which is a product decision, not a tuning knob).
8. **These numbers carry no staging authority** and must not be adjusted after seeing a result.

## 10. CI conditions

- The benchmark is **not** a CI gate and must not run in CI (non-deterministic, needs staging). CI keeps running the existing correctness-only `MEASURE` test inside `verify` (gapless numbering under 16-way concurrency).
- The closure branch needs the normal four CI jobs (`verify`, `e2e`, `realtime`, `security`) green on its own PR before the latency gate is judged, so the benchmarked build is the CI-verified build.
- The staging report is archived under `docs/phase-3/` (evidence), referencing the SHA that CI verified.

## 11. What the owner must provide to complete HG3b-SALE-LATENCY

1. **Environment:** authorise and provision (or name the provider and budget for) the staging environment of §2 and §8.2 items 1–2, 6.
2. **Demand input:** expected **peak sales/s per company**, registers per company, companies per tenant, tenants per cluster, peak sales/day, expected report usage while selling.
3. **Approved criteria, in writing, before the first run:** accept / change / replace T1–T6 of §9, decide the T2 measurement point (§9.1 item 1), decide the S4 degradation bound (T7), and whether S5 is pass/fail or informational.
4. **Dataset tooling:** approve building a **remote seeding tool** for D0–D3 (the existing generators cannot seed a remote database) — a new, reviewed task.
5. **Independent review** of the driver (`apps/api/src/staging-benchmark/`) by someone other than its author.
6. **Operator + schedule** for the campaign, and who signs the final report.
7. **Decision on the closure-branch CI:** the build benchmarked must be the build that the closure branch's own CI verified (§10).

Until items 1–7 exist, **HG3b-SALE-LATENCY stays OPEN** and no latency, throughput or capacity statement may be made.
