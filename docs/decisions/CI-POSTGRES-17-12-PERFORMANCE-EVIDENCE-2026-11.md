# CI failures: 10 frozen performance / query-plan tests fail on PostgreSQL 17.12 and pass on 17.11 — evidence and owner decision

**Status: EVIDENCE + DECISION REQUEST.** Prepared 2026-11-18. No threshold, test, frozen contract or production code was changed. Nothing is skipped and no failed check is relabelled green.

## 1. What fails

CI `verify` ("Unit + integration tests") is red on **every** PR since 2026-11-18, including the docs-only PR #42, with the same tests:

| Test file (apps/api/src/modules/reporting)                | Failing | Assertion                                                 |
| --------------------------------------------------------- | ------- | --------------------------------------------------------- |
| `sales-financial-report.query-plan.integration.test.ts`   | 6 of 9  | `a nested loop seq-scans journal_entry per outer row`     |
| `sales-financial-report.dense-window.integration.test.ts` | 2 of 9  | timing ratio, e.g. `expected 3476 to be less than 2790.5` |
| `tender-totals-report.dense-window.integration.test.ts`   | 2 of 11 | timing ratio, e.g. `expected 4416 to be less than 3320.5` |

(Docs-only PR #42 and PR #44 showed 8; PR #43 and the re-run of `main` showed all 10 — the two `sales-financial-report.dense-window` cases sit near their ratio thresholds.)

## 2. Same commit, green then red

`main` @ `ea56cff` was **green** on 2026-11-10 (CI run 42795556220, attempt 1). Re-running that exact run on 2026-11-18 (attempt 2) is **red** with the 10 failures above. The code is identical, so the cause is the environment. Two things differ between the attempts:

|                     | 2026-11-10 (green)                          | 2026-11-18 (red)                                                  |
| ------------------- | ------------------------------------------- | ----------------------------------------------------------------- |
| Runner image        | `ubuntu-26.04` 20261101.186.1               | `ubuntu-26.04` 20261111.82.6                                      |
| Test database image | floating tag `postgres:17` (pulled per run) | same floating tag, now **PostgreSQL 17.12** (released 2026-11-12) |

## 3. Reproduction on one machine, one variable (the Postgres image)

Clean checkout of `origin/main` (`ea56cff`), Docker Desktop, tests run one file at a time; the only thing changed is which image the tag `postgres:17` resolves to.

| Test file                  | PostgreSQL **17.11** (`17.11-1.pgdg13+2`) | PostgreSQL **17.12** (`17.12-1.pgdg13+1`) |
| -------------------------- | ----------------------------------------- | ----------------------------------------- |
| query-plan                 | **9 / 9 pass**                            | **6 failed**, 3 passed                    |
| sales dense-window         | **9 / 9 pass**                            | **2 failed**, 7 passed                    |
| tender-totals dense-window | **11 / 11 pass**                          | **2 failed**, 9 passed                    |

The failures are deterministic, not flaky. With a one-line pin of the API test stack to `postgres:17.11` (PR proposed below) all 29 tests pass while the floating tag resolves to 17.12.

## 4. Likely mechanism (NOT proven)

The query-plan test inspects `EXPLAIN (ANALYZE)` and fails when a Nested Loop's inner side is a Seq Scan of a ledger/document table executed more than the process count — i.e. 17.12 chose a different (worse) plan for the sales-financial report statement, and the two dense-window suites then run slower relative to their calibrated ratios. The 17.12 release notes (https://www.postgresql.org/docs/17/release-17-12.html) list planner changes in this area, notably a **rewrite of join-removal code** and fixes to lateral references / nested-loop parameters; the notes do not describe a nested-loop plan change as such. I have **not** captured and diffed the two plans, so the cause inside 17.12 is a hypothesis.

## 5. Why this matters beyond CI

The tests guard the performance of the **frozen Phase 3b.10 report statements** (sales-financial, tender-totals). If a deployment runs PostgreSQL 17.12 those reports may be slower or pathological regardless of what CI does. Staging as prepared (PR #48) uses the floating `postgres:17`, which is now 17.12. Conversely 17.12 carries upstream fixes, so staying on an old minor is not a free choice for a production database.

## 6. Options

| #   | Option                                                                                                                                                                                               | Effect                                                                    | Cost / risk                                                                                                                                      |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Merge the one-line test pin (`packages/testing` `postgres:17.11`, PR proposed)                                                                                                                       | CI `verify` stops failing on these 10 tests; no threshold or test touched | Hides the 17.12 behaviour from CI; must be paired with option 2                                                                                  |
| 2   | Capture `EXPLAIN (ANALYZE, BUFFERS)` of the report statements on 17.11 vs 17.12 and decide: statement/index change (a **frozen-contract amendment**, owner decision) or a PostgreSQL upstream report | Fixes the real risk                                                       | Needs owner approval for any frozen code or index change; accountant not involved (no figure changes) but report output must stay byte-identical |
| 3   | Do nothing                                                                                                                                                                                           | `verify` stays red                                                        | Blocks every PR from a green required check                                                                                                      |
| 4   | Loosen the thresholds                                                                                                                                                                                | —                                                                         | **Rejected**: weakens frozen gates                                                                                                               |

**Recommendation:** 1 + 2 — pin the test infrastructure now (CI becomes deterministic and honest about the version under test), run the plan comparison as the next investigation, and keep staging on a **verified** PostgreSQL minor (decide: pin staging to 17.11 temporarily — internal alpha, no real data — or accept 17.12 and slower reports until option 2 is done). Moving the pin forward to 17.12 is then a deliberate, evidence-backed change.

## 7. Decisions needed

1. Owner: choose option 1, 2, both, or other; and whether the staging Compose should pin PostgreSQL.
2. If option 2: authorise capturing the two plans (read-only, disposable databases, no schema change) and confirm that any resulting statement/index change goes through frozen-contract amendment review.
3. Independent security reviewer: only informational — 17.12 contains upstream fixes, so any pin should carry an expiry.
