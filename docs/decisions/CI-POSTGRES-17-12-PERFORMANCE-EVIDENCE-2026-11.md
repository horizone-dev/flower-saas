# CI failures: 10 frozen performance / query-plan tests fail on PostgreSQL 17.12 and pass on 17.11 — evidence, plan comparison and owner decision

**Status: EVIDENCE + DECISION REQUEST.** Prepared 2026-11-18, updated the same day with the owner-authorised plan comparison (§4–§7). No threshold, test, frozen contract, statement, index or production code was changed. Nothing is skipped and no failed check is relabelled green. PR #51 (the temporary CI pin) stays **unmerged** until this comparison and its review are accepted.

## 1. What fails

CI `verify` ("Unit + integration tests") is red on every PR except #51 since 2026-11-18, including the docs-only PR #42, with the same tests:

| Test file (apps/api/src/modules/reporting)                | Failing | Assertion                                                                         |
| --------------------------------------------------------- | ------- | --------------------------------------------------------------------------------- |
| `sales-financial-report.query-plan.integration.test.ts`   | 6 of 9  | `a nested loop seq-scans journal_entry per outer row`                             |
| `sales-financial-report.dense-window.integration.test.ts` | 2 of 9  | rejection must cost under half of an accepted report, e.g. `2810 < 2110` violated |
| `tender-totals-report.dense-window.integration.test.ts`   | 2 of 11 | the same ratio gate, e.g. `4482 < 3459.5` violated                                |

Failure counts in the CI logs re-read on 2026-11-18: **10** on #42, #44 (after a re-run) and #48; **8** on #49, where the two `sales` dense-window cases passed that time. An earlier version of this document recorded 8 on first runs of #42 and #44 and 10 on #43 and a re-run of `main`. The two `sales` dense-window cases sit near their ratio threshold on a CI runner, which is why the count varies between 8 and 10; locally on 17.12 they failed on every run. The other PRs (#43, #45, #46, #47, #50) also show `verify` failed; I did not re-read their individual counts today. Separately, one early `verify` run on #44 failed on a Testcontainers start timeout ("Hook timed out in 10000ms" in `packages/db`), not on these tests; its re-run produced the 10 above.

## 2. Same commit, green then red

`main` @ `ea56cff` was green on 2026-11-10 (CI run 42795556220, attempt 1). Re-running that exact run on 2026-11-18 (attempt 2) is red with the failures above, so the cause is the environment. Two things differ:

|                     | 2026-11-10 (green)                          | 2026-11-18 (red)                                                  |
| ------------------- | ------------------------------------------- | ----------------------------------------------------------------- |
| Runner image        | `ubuntu-26.04` 20261101.186.1               | `ubuntu-26.04` 20261111.82.6                                      |
| Test database image | floating tag `postgres:17` (pulled per run) | same floating tag, now **PostgreSQL 17.12** (released 2026-11-12) |

## 3. One machine, one variable (the Postgres image)

Clean checkout of `origin/main` (`ea56cff`), Docker Desktop, one test file at a time, the image the only change (`17.11-1.pgdg13+2` against `17.12-1.pgdg13+1`).

| Test file                  | PostgreSQL 17.11 | PostgreSQL 17.12     |
| -------------------------- | ---------------- | -------------------- |
| query-plan                 | **9 / 9 pass**   | **6 failed**, 3 pass |
| sales dense-window         | **9 / 9 pass**   | **2 failed**, 7 pass |
| tender-totals dense-window | **11 / 11 pass** | **2 failed**, 9 pass |

Re-run on 2026-11-18 for this comparison with identical results; the failures are deterministic. With the one-line pin in PR #51 all 29 tests pass while the floating tag resolves to 17.12.

## 4. The plan comparison (owner-authorised, read-only, disposable databases)

**Method.** `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` of the real report statements, through the real RLS role, on the disposable datasets the tests themselves generate (query-plan: 18,000 invoices, 29,160 journal entries, 1,800 credit notes, 3 years; dense: 25,000 invoices in a 90-day window for sales and 100,000 movements for tender). Both versions ran on the same dataset generator on the same machine, one heavy run at a time. The test files and their thresholds were not modified; extra plan capture and the image selector were scratch-only changes (an untracked copy of the plan test and an environment override in a gitignored `dist`), and nothing from them is in this repository. Raw plan JSON is kept outside the repository.

### 4.1 Finding A — a genuine plan regression in one probe (query-plan test)

The sales-financial statement contains an integrity probe, `creditNotesWithoutRevenueJournal` in `sales-financial-report.sql.ts` (`LEFT JOIN LATERAL ( SELECT 1 FROM journal_entry j3 WHERE … j3."sourceKind" IN (…) AND j3."sourceId" = d."invoiceId"::text LIMIT 1 )`). Same statement, same statistics, same data:

|                                                          | 17.11                                                                                            | 17.12                                                                                               |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| Probe access path                                        | `Index Scan` on `journal_entry_tenantId_companyId_sourceKind_sourceId_key`, estimated cost 12.87 | **`Seq Scan` of `journal_entry` per outer row**, estimated cost 1,387; 11,499 rows removed per loop |
| Cost per loop (90-day window, 99 loops)                  | about 0.005 ms                                                                                   | about 3.3 ms                                                                                        |
| The neighbouring probe (`CASE` equality on `sourceKind`) | Index Scan                                                                                       | Index Scan (unchanged)                                                                              |

Statement execution time, company-wide scenarios (`EXPLAIN ANALYZE`, same dataset):

| Window                       | Documents   | 17.11 ms     | 17.12 ms     | Seq-scan probe on 17.12 |
| ---------------------------- | ----------- | ------------ | ------------ | ----------------------- |
| last single day              | 13          | 6.6          | 14.9         | yes                     |
| last 7 days                  | 86          | 19.1         | 81.2         | yes                     |
| mid-history 30 days          | 369         | 41.1         | 100.9        | yes                     |
| last 90 days (the sales cap) | 1,105       | 110.3        | 456.4        | yes                     |
| last 365 days                | 4,480       | 344.3        | 1,760.9      | yes                     |
| full history                 | 13,439      | 1,198.6      | 6,173.3      | yes                     |
| branch slice, 90 days / full | 246 / 3,000 | 44.3 / 480.2 | 53.4 / 505.3 | no (not affected)       |

**Does it grow with the ledger?** Same 90-day window (1,105 documents), ledger tripled (29,160 → 87,480 journal entries):

| Statement                                    | 17.11               | 17.12                           |
| -------------------------------------------- | ------------------- | ------------------------------- |
| As shipped                                   | 126 → 137 ms (flat) | **441 → 1,205 ms (about ×2.7)** |
| Probe rewritten as `NOT EXISTS` (experiment) | 137 → 190 ms        | 127 → 145 ms (flat)             |

So on 17.12 the cost of this probe follows the **size of the ledger** times the number of credit notes in the window. This is measured at two ledger sizes; anything larger is extrapolation (a linear reading would put a window with the same 99 credit notes at roughly 13 seconds on a ledger of one million entries, and a maximum-size window with several thousand credit notes at minutes). It has not been measured at that scale.

**What changes the plan on 17.12** (experiments on the 17.12 disposable database, 90-day window, as-shipped 441 ms):

| Experiment                                                          | Result on 17.12                                                                | Reading                                                                                                                |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `SET LOCAL enable_seqscan = off`                                    | 503 ms, a `Bitmap Heap Scan` per loop                                          | the plain index probe is not what the planner builds for this shape any more, even when sequential scans are forbidden |
| `sourceKind IN (a, b)` replaced by `= a`                            | 319 ms, `Bitmap Heap Scan`                                                     | removing the IN list helps a little but does not restore the index probe                                               |
| The probe rewritten as `NOT EXISTS (SELECT 1 … )` (same predicates) | **127 ms** (17.11 as shipped: 126 ms); full history 1,214 ms (17.11: 1,176 ms) | restores 17.11 timing; on 17.11 it is neutral                                                                          |

The rewritten statement returned the same JSON as the shipped one on these datasets. **That is not a proof of equivalence**: the probe counts anomalies and is 0 on consistent data. `LEFT JOIN LATERAL … LIMIT 1 … WHERE hit IS NULL` and `NOT EXISTS` are the standard equivalent forms, but any adoption would need a mutation test that plants an anomaly.

### 4.2 Finding B — the dense-window failures are a JIT cost the plan estimate now triggers

| Dense window (default `jit = on`)                            | 17.11               | 17.12                                             |
| ------------------------------------------------------------ | ------------------- | ------------------------------------------------- |
| **Sales** accepted report, full service p50                  | 2,868 ms            | 5,872 ms                                          |
| Sales over-limit rejection p50 (gate: under 0.5 × accepted)  | 772 ms              | 5,231 ms                                          |
| Sales accepted plan, estimated total cost                    | 301,330             | 502,104                                           |
| **Tender** accepted report, full service p50                 | 3,188 ms            | 6,919 ms                                          |
| Tender over-limit rejection p50 (gate: under 0.5 × accepted) | 788 ms              | 4,444 ms                                          |
| Tender accepted plan, estimated total cost                   | 182,853             | **66,866,188**                                    |
| Tender JIT time inside the statement                         | 265 ms, no inlining | **4,185 ms** (optimisation 2,339 ms, inlining on) |

The buffer counts of the over-limit statement are identical on both versions (1,724 shared hits for sales), so no extra data is read. On 17.12 the planner's estimated cost crosses PostgreSQL's default `jit_optimize_above_cost` / `jit_inline_above_cost` (500,000), so the server spends seconds compiling and optimising the statement. The 17.12 sales plan also contains the Finding-A `Seq Scan` probe, never executed in that window (0 loops) but still costed.

**Attribution check (diagnostic only; the gates still judge PostgreSQL's defaults).** The same dense files re-run on 17.12 with the database started with `jit=off`:

| Dense window                         | 17.11 (`jit=on`) | 17.12 (`jit=on`) | 17.12 (`jit=off`) |
| ------------------------------------ | ---------------- | ---------------- | ----------------- |
| Sales accepted, full service p50     | 2,868 ms         | 5,872 ms         | **2,666 ms**      |
| Sales over-limit rejection p50       | 772 ms           | 5,231 ms         | **649 ms**        |
| Sales result                         | 9 / 9            | 2 failed         | **9 / 9**         |
| Tender accepted, full service p50    | 3,188 ms         | 6,919 ms         | **2,974 ms**      |
| Tender over-limit rejection p50      | 788 ms           | 4,444 ms         | **616 ms**        |
| Tender accepted plan, estimated cost | 182,853          | 66,866,188       | 67,904,036        |
| Tender result                        | 11 / 11          | 2 failed         | **11 / 11**       |

With JIT off, 17.12 executes these statements as fast as 17.11 even though the planner's estimate is still inflated. So the dense-window failures are **entirely the JIT cost**, not slower execution. That is a real cost with default settings, but a different kind from Finding A.

## 5. Does 17.12 cause only test-plan instability, or a production risk?

**It is a genuine production performance risk for the statements as written, not just test instability.**

- **Finding A** is a real plan regression in one probe of the frozen sales-financial report statement. Its cost grows with ledger size on 17.12 and not on 17.11. It does not depend on test thresholds or runner speed, and its node-level cost (99 loops × about 3.3 ms ≈ 327 ms) accounts for nearly all of the 90-day difference (110 ms → 456 ms, +346 ms) without invoking JIT.
- **Finding B** makes the largest accepted reports about twice as slow on 17.12 with PostgreSQL's default settings (`jit = on` is the default in the official image), and makes the "cheap rejection" path as expensive as an accepted report. These are timings of a local test container, not a production SLA, and the local engineering gate of 10 s is still met.
- **Exposure today:** none in production (there is no production). The planned alpha uses dummy data and small ledgers, so a user would not notice. The staging stack prepared in PR #48 uses the floating tag `postgres:17`, which is now 17.12.
- **Why pinning to 17.11 is not a full answer:** 17.12 contains upstream fixes (the [official notes](https://www.postgresql.org/docs/17/release-17-12.html) list mostly memory-safety and correctness fixes), so a long-lived pin to an old minor is not free for a production database.
- **Possible cause, not proven.** The same notes list a back-ported rewrite of join-removal ("a significant change that normally we'd never consider back-patching") and fixes to lateral references and PlaceHolderVar handling, which is the shape of the Finding-A probe. The notes do not describe a plan-choice change. I did not bisect the PostgreSQL source.

## 6. Options

| #   | Option                                                                                                                                                     | Effect                                                                   | Cost / risk                                                                                                                                                                                                                                 |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Merge the one-line test pin (PR #51, `postgres:17.11`)                                                                                                     | CI `verify` is deterministic and green; no threshold or test touched     | Hides the 17.12 behaviour from CI. Acceptable only **paired with 2 or 3** and with an expiry                                                                                                                                                |
| 2   | Amend the frozen statement: probe as `NOT EXISTS` (measured above); owner-approved, with equivalence mutation test and the reports' figures byte-identical | Restores 17.11 timing on 17.12 for Finding A                             | **Frozen-contract amendment** (statement text of a frozen report), owner decision; Finding B must be re-measured after it                                                                                                                   |
| 3   | Run staging/production on 17.11 for now (pin the staging Compose and the CI image)                                                                         | Avoids both findings until 2 lands                                       | Skips 17.12 fixes; needs an expiry and a named owner for moving the pin forward                                                                                                                                                             |
| 4   | Set `jit = off` (or raise the JIT cost thresholds) on the database                                                                                         | Removes Finding B (verified above: both dense files pass with `jit=off`) | A database-wide setting change in staging/production, and a changed condition for the test stack; it does not fix Finding A; the gates were calibrated on PostgreSQL's defaults, so adopting it in CI is an owner decision, not a quiet fix |
| 5   | Report to PostgreSQL upstream with the reproducer                                                                                                          | Long-term                                                                | Not a December fix                                                                                                                                                                                                                          |
| 6   | Do nothing                                                                                                                                                 | `verify` stays red                                                       | Blocks every PR from a green required check                                                                                                                                                                                                 |
| 7   | Loosen the thresholds                                                                                                                                      | —                                                                        | **Rejected**: weakens frozen gates                                                                                                                                                                                                          |

**Recommendation:** 1 + 2 + 3 together. Merge the pin (PR #51) with an expiry date and a note pointing here; pin staging to the same minor; and take the `NOT EXISTS` amendment through the frozen-contract review so that moving to 17.12 is a deliberate, tested change. After 2, re-measure Finding B: the rewrite removes the costed `Seq Scan` probe and may bring the estimate back under the JIT thresholds (not tested); if it does not, option 4 is the remedy for it and is a separate owner decision.

## 7. Decisions needed

1. **Owner:** accept the comparison; choose among options 1–7 (recommended 1 + 2 + 3); say whether the staging Compose pins PostgreSQL.
2. **Owner + reviewer:** whether to open the frozen-contract amendment for the probe (option 2). Nothing has been written for it beyond the experiment above; no frozen file was edited.
3. **Independent security reviewer:** informational only; 17.12 contains upstream fixes, so any pin must carry an expiry.
4. **PR #51** stays unmerged until items 1–3 are recorded.
