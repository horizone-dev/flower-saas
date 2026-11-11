# Phase 3B — closure decision gate and evidence (OWNER-DECISION PACKAGE, NOT a completion declaration)

- **Date:** 2026-11-12. **Branch:** `phase-3/3b-closure-hardening` (isolated worktree `C:\Users\EXPERT\fwt\b3c`), based on `origin/main` = `ea56cff`.
  **Nothing is committed, pushed, merged, tagged or deployed; no PR is open. The Phase 4 worktree (`C:\Users\EXPERT\fwt\p4`) was not touched.**
- **Verdict: Phase 3B is NOT complete and must not be declared complete.** Reporting correctness is proven for the **summary** route only; the frozen Sales
  and Tender Totals reports are unchanged and the amendment is **owner-gated**. **Accountant sign-off is not recorded** (and was not filled in on anyone's
  behalf), **no staging performance run exists**, and **the branch has never run in GitHub CI**. Each of those is a mandatory release gate.
- **Reading order.** §0 is this round (the nine closure items, the release-blocker checklist and the exact owner-decision package). §1–§10 are the
  previous round's evidence, **corrected where this round found them stale** (each correction is marked _[corrected]_). Appendices are earlier rounds.
- **Honest account of changes beyond the literal brief (each needed, each reversible, each listed):** (1) migration 50 — never applied or pushed — was edited
  to add the F-4 guards, a read-only platform grant, a `search_path` pin on every guard function (IV-1) and an attribution CHECK (IV-2); **its pinned hash was
  re-pinned twice**: `52693cf2…ab1c` → `d12edf2b…b242` → **`c172db11…8d00`** (full value in §0.4); (2) the repository takes the
  **document, journal and outcome timestamps — including the note's and its lines' `createdAt` — from the application's accounting clock** instead of the
  database clock (the earlier phrase "every timestamp" was an overstatement that the independent review caught; it is now true for the RB-1 tables'
  business timestamps, and the claim is tested); (3) three control queries (Q7, Q8, Q9) and a larger document set; (4) one reviewed exemption inside the 3b.10
  F pin file (§0.5).

## 0. THE DECISION-GATE ROUND

### 0.0 VERIFICATION OF THE FINAL TREE — **COMPLETE LOCALLY (clean, sequential, low-memory); CI NOT YET RUN**

**Method.** One process at a time on a 16 GB Windows laptop (3 – 4.5 GB free throughout; Docker VM capped at 8 GB, nothing left running between stages). A stage
runner refused to start a command if another Flower process was active or free memory was below a floor (2,800 MB; 1,800 MB for plain unit-test packages that
start no container), ran **no retries**, waited for every Testcontainers container to be released after each Docker batch, and appended every result to a ledger.
Static stages used heap 2,048 MB, test batches 1,536 MB, one Vitest worker, file parallelism off. **A non-zero exit, a kill, a timeout or an unstarted command is
never counted as a pass.** `run-master.sh` and `turbo`'s workspace-wide parallelism were not used.

**History, disclosed (none of it is cited as evidence).** A first verification launch ran twice at once by my error (logs quarantined: 32 files). A second
single run was stopped by the harness for low memory; its typecheck had died with `0xC0000142` (resource exhaustion, not a TypeScript diagnostic). In this round a
first build attempt was stopped by me because the package list came out alphabetical instead of dependency-first (fixed with a real topological order), and the
first attempt at the 21 remaining package runs was **refused by the memory gate (free 2.6 – 2.7 GB < 2.8 GB floor) and is recorded NOT-RUN**; they were then run
under the tiered floors below and all passed. Two scanner glitches are also disclosed in §0.6.

**Static gates (final tree, uncached where it matters):**

| Stage                                             | Scope                                         | Exit | Result                                                                                                                   |
| ------------------------------------------------- | --------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------ |
| `build` (package scripts, dependency order)       | 22 packages                                   | 0    | **22 / 22 pass**                                                                                                         |
| `build`, **uncached** (incremental cache deleted) | `@flower/db`, `@flower/api`                   | 0    | pass (the financial code compiled from scratch)                                                                          |
| `typecheck`                                       | 22 packages + `spike-rls`                     | 0    | **23 / 23 pass**                                                                                                         |
| `lint` (ESLint)                                   | 22 packages + `tooling-scripts` + `spike-rls` | 0    | **24 / 24 pass, 0 errors; 5 warnings = the 5 pre-existing waived `no-console` in `reconcile-historical-settlements.ts`** |
| negative boundary check                           | `@flower/config test:negative`                | 0    | pass                                                                                                                     |
| Prettier                                          | repository-wide `format:check`                | 0    | all matched files use the Prettier style                                                                                 |

**Regression (final tree; passed / skipped / failed / killed):**

| Batch                                                                                                                                                                                                                                           | Files                               | Passed    | Skipped | Failed |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- | --------- | ------- | ------ |
| A01 access, identity, org, secrets, platform                                                                                                                                                                                                    | 13                                  | 130       | 0       | 0      |
| A02 cross-tenant + branch-isolation probes                                                                                                                                                                                                      | 2                                   | 22        | 0       | 0      |
| A03 customers, localization                                                                                                                                                                                                                     | 8                                   | 158       | 0       | 0      |
| A04 receivables                                                                                                                                                                                                                                 | 23                                  | 387       | 0       | 0      |
| A05 payments                                                                                                                                                                                                                                    | 18                                  | 326       | 0       | 0      |
| A06 settlements                                                                                                                                                                                                                                 | 4                                   | 130       | 0       | 0      |
| A07 orders                                                                                                                                                                                                                                      | 10                                  | 464       | 0       | 0      |
| A08 sales (incl. the 3b.9 structural pins)                                                                                                                                                                                                      | 15                                  | 819       | 0       | 0      |
| A09 catalog                                                                                                                                                                                                                                     | 17                                  | 323       | 0       | 0      |
| A10 accounting                                                                                                                                                                                                                                  | 6                                   | 68        | 0       | 0      |
| **A11 anonymous credit notes + refunds + summary**                                                                                                                                                                                              | 5                                   | **67**    | 0       | 0      |
| A12 staging benchmark                                                                                                                                                                                                                           | 2                                   | 20        | 0       | 0      |
| A13 reporting structural pins (3b.10 A–F)                                                                                                                                                                                                       | 6                                   | 406       | 0       | 0      |
| A14 reporting — sales                                                                                                                                                                                                                           | 6                                   | 141       | 0       | 0      |
| A15 reporting — tender totals                                                                                                                                                                                                                   | 4                                   | 153       | 0       | 0      |
| A16 reporting — receivables, customer liabilities                                                                                                                                                                                               | 6                                   | 148       | 2       | 0      |
| A17 reporting — trial balance, ranges, controller                                                                                                                                                                                               | 6                                   | 118       | 0       | 0      |
| A18 PCI bounded-negative, route sweep, exit scenario, authorised-additions + fixture pins                                                                                                                                                       | 10 (7 ran, 3 opt-in)                | 72        | 9       | 0      |
| A19 common, health, config                                                                                                                                                                                                                      | 16                                  | 145       | 0       | 0      |
| **`apps/api` total**                                                                                                                                                                                                                            | **177 (174 ran + 3 opt-in)**        | **4,097** | **11**  | **0**  |
| `@flower/db` D1 – D6 (RLS / migration isolation, 3b.8 provenance and refund scope, closure, accounting, customer, numbering, payments, receivables, safe-logging, sale-tax, settlement)                                                         | 20                                  | **793**   | 0       | 0      |
| 17 other packages (money 50, uom 74, shared-types 38, i18n 4, permissions 29, safe-logging 40, service-runtime 7, api-client 18, realtime-client 21, ui 3, config 491, scheduler 12, worker 97, realtime 60, pos-pwa 4, testing 16, backend 20) | 57                                  | **984**   | 0       | 0      |
| PgBouncer RLS spike (`tooling/spikes/rls`)                                                                                                                                                                                                      | 1                                   | **21**    | 0       | 0      |
| customer-web, owner-web, super-admin-web                                                                                                                                                                                                        | no test files (`--passWithNoTests`) | 0         | 0       | 0      |
| **Everything**                                                                                                                                                                                                                                  | —                                   | **5,895** | **11**  | **0**  |

The API total is the previous round's 4,092 **plus the 5 new integrity tests** (62 → 67 in the anonymous module); DB and package totals are unchanged.
**Excluded / skipped, never counted as passed:** 3 files / 9 tests = the opt-in `G_LOAD` Checkpoint-G load files; 2 tests = the opt-in 100,000-record density tests;
**not run at all:** the Playwright e2e suite and the CI `security` job (CI only). **Not re-run this round:** the mutation sweeps (§6.2) — the sources changed
afterwards only by Prettier formatting; the tests that pin the mutated behaviour pass.

**Integrity audit (final tree, read-only):** migration 50 `c172db11…8d00`, schema block `c8ff3ba0…78b6bf` and frozen schema remainder `15ef99ce…` equal their pins
(independent script); the 49 original migrations are byte-identical to `HEAD` (0 changed); every frozen reporting production file and the 8 pinned production
files are identical to `HEAD`; the R-1.1 trial restoration is byte-identical to its pre-trial backup; `package.json`, lockfile, workflows, `turbo.json` and
`.npmrc` are unchanged; 80 changed / new files (29 modified, 51 new), no leftover patch artefacts. **F-4 protections read from the files:** 8 guard functions,
8 `SET search_path = public, pg_temp` pins, 0 `SECURITY DEFINER`; the state CHECK requires `resolvedByUserId` for `EXECUTED` and `FAILED`; both execution and
issuance guards are `CONSTRAINT TRIGGER … DEFERRABLE INITIALLY DEFERRED`; the repository refuses attestation without a user (`ATTESTER_REQUIRED`, 2 call sites)
and takes timestamps from the accounting clock — and **each of these is exercised by a passing test** (SHADOWING ×2, ATTRIBUTION, SINGLE CLOCK, the guard
bypass tests, the structural pin). The Phase 4 worktree is unchanged (branch `phase-4/cash-register-foundation`, 53 entries).

**What this does NOT show:** CI on this branch; any staging performance figure; accountant sign-off; that the frozen reports show anonymous credits (they do not
— the summary does). A passing local run on one machine is evidence, not a release.

### 0.1 The nine requested items — state and where the evidence is

| #   | Item                                                                                                                                  | State                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Evidence                                                                                                  |
| --- | ------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| 1   | **R-1.1 Sales Report integration** and its exact frozen-contract amendments; a fully reversed anonymous sale must not look reconciled | **Demonstrated on a real database, then REVERTED.** Frozen report: a fully reversed sale returns `200 reconciled:true` with `netSalesAfterCreditNotesExTax = 6666` while the ledger shows `0` (the report is blind to the credit). Amended report: the credit appears (`6666 / 333 / 6999`), net-after-all-credits is `0 / 0 / 0`, and two tampering cases now fail closed (`500 REPORT_SALES_GL_MISMATCH` / `500 REPORT_SALES_SOURCE_INTEGRITY`). The exact patch touches the frozen files and **19 pin assertions**; the tree is back to byte-identical frozen files. | `R-1-REPORTING-AMENDMENT-SPEC.md` §3.6; `amendments/R-1.1/` (patch, demonstration test, measured outputs) |
| 2   | **R-1.2 Tender Report** recommendation, distinguishing cash/bank, pending, failed and manually attested card refunds                  | **Written; not implemented, not trial-verified.** Four situations with a recommended treatment each; four owner rulings (T-1…T-4) are prerequisites; a manual card / other refund has **no journal and therefore no period authority** — that is a policy ruling, not an engineering choice.                                                                                                                                                                                                                                                                            | `R-1.2-TENDER-REPORT-RECOMMENDATION.md`                                                                   |
| 3   | **Independent verification** of migration 50, the deferred triggers and the single clock; all hashes and pins                         | **Done; found 2 real weaknesses and 1 overstatement — all fixed and tested** (IV-1 temp-table shadowing bypass of the guards — High; IV-2 anonymous attestation — Medium; IV-3 clock overstatement — Low). All authorisation hashes recomputed by an independent script and equal to the pinned values (§0.4).                                                                                                                                                                                                                                                          | `RB-1-INDEPENDENT-VERIFICATION-AND-TRUST.md`; integrity suite (15 tests); structural pin (16 tests)       |
| 4   | **Accountant-ready reconciliation package**; **no sign-off recorded**                                                                 | **Written.** Accounts touched, a worked example in every refund state, `PAYMENT_CLEARING` tie-out, pending-refund liability at period end, manual-card / settlement measurement, period-end procedure, a worksheet and a **BLANK** sign-off form.                                                                                                                                                                                                                                                                                                                       | `RB-1-ACCOUNTANT-RECONCILIATION-PACKAGE.md`; `RB-1-ACCOUNTANT-CONTROL-QUERIES.sql` (Q1–Q9, run by a test) |
| 5   | **No refund executed without financial evidence**; trust assumptions disclosed                                                        | **Verified by attack tests**, with the residual stated: ten disclosed assumptions TA-1…TA-10 (a human attestation of a card refund; cash physically leaving; an honest attester; trusted superusers; …).                                                                                                                                                                                                                                                                                                                                                                | verification doc §4–§5                                                                                    |
| 6   | **The 12 pin amendments + the additional exemption**, individually; exact approval per category                                       | **Reviewed one by one and sensitivity-tested** (a deliberate violation of what each pin protects makes it fail; the tree was restored byte-for-byte). Five categories A–E and seven yes / no approvals P1–P7 are requested (§0.3). **None is self-approved.**                                                                                                                                                                                                                                                                                                           | `PHASE-3B-PIN-AMENDMENT-REVIEW.md`                                                                        |
| 7   | **Staging seeding implementation plan**, approved-workload decision sheet, performance acceptance criteria                            | **Written; nothing built, no environment, no result.** Plan S-1…S-8 with an acceptance test each; one finding that matters: the existing fixture creates **no payments**, so it does not exercise Tender Totals, and post-run check 4 must be scoped to the run.                                                                                                                                                                                                                                                                                                        | `HG3B-STAGING-SEEDING-PLAN.md` §7; `HG3B-PERFORMANCE-DECISION-SHEET.md`                                   |
| 8   | **Closure branch prepared for CI**, fresh security scan; **no commit / push / PR / merge / deploy**                                   | **Prepared, not pushed.** The full static gates and regression were re-run on the final tree (§0.0: 5,895 passed, 11 skipped, 0 failed). Fresh scans on scratch copies of the final tree (never the worktree), each with a positive control (§0.6): OSV **765 packages, 0 issues**; gitleaks **clean under CI's own configuration (80 files, 859 KB scanned)**; Trivy filesystem **0 findings**; Trivy config **2 LOW only**, in two Dockerfiles this branch does not touch and below CI's HIGH / CRITICAL gate. **Not run: CI itself.**                                | §0.6, §6                                                                                                  |
| 9   | This document and a **concise release-blocker checklist**                                                                             | **Done** — §0.2.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | here                                                                                                      |

### 0.2 Release-blocker checklist (concise)

| #   | Mandatory gate                                                                                                             | State                                                                                                | Who unblocks it               |
| --- | -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ----------------------------- |
| B1  | **Financial reporting correctness** — the credits reach the reports an accountant reads                                    | ⏸ **summary proven; frozen reports not amended**                                                     | owner: R-1 decision (§0.3 D1) |
| B2  | **Accountant sign-off** S1–S13 on the reconciliation package                                                               | ❌ **OPEN — blank form, not completed by engineering**                                               | the accountant                |
| B3  | **Owner approvals** of the pin amendments and engineering changes P1–P9 and the policy decisions D1–D6 of §0.3             | ❌ **OPEN**                                                                                          | owner                         |
| B4  | **Staging performance** (HG3b-SALE-LATENCY): environment, workload, criteria, seeding tool, independent review             | ❌ **OPEN — nothing exists; no figure has been measured**                                            | owner + infrastructure        |
| B5  | **Branch CI** (`verify`, `e2e`, `realtime`, `security`) green on the PR head after a fresh scan                            | ❌ **OPEN — branch never pushed**                                                                    | owner approves push / PR      |
| B6  | **Independent human review** of migration 50, the guards and the repository (author ≠ reviewer)                            | ❌ **OPEN — recommended; this review was by the author**                                             | owner assigns                 |
| B7  | Platform hardening `REVOKE TEMPORARY` (TA-10) or a reviewed pass over the frozen triggers                                  | ❌ **OPEN — owner / infrastructure decision**                                                        | owner                         |
| B8  | **Clean, complete local verification of the final tree** (static gates, API / DB / package suites, RLS spike, fresh scans) | ✅ **DONE locally (§0.0): 5,895 passed, 11 skipped, 0 failed; all static gates exit 0; scans clean** | — (CI is still B5)            |

**Phase 3B is not complete until B1–B5 are satisfied (B6 and B7 are strongly recommended). `phase-3-complete` must not be tagged.**

### 0.3 The exact owner-decision package (each answerable on its own)

**Reporting and accounting policy (not self-approved):**

| #   | Decision                                                                                                                                                           | Recommended default                                          |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| D1  | **R-1:** ship the pilot with the summary only (R-1.0); schedule R-1.1 (Sales) next, using the trial-verified patch; R-1.2 (Tender) only after T-1…T-4              | R-1.0 now, R-1.1 before general availability, R-1.2 deferred |
| D2  | **T-1…T-4** (R-1.2 rulings), chiefly: how a **manual card / other** refund is dated in a journal-anchored report when it has no journal                            | decide only if R-1.2 is wanted                               |
| D3  | **P1 or P2** for pending refunds (`PAYMENT_CLEARING` carries a credit while a refund is in flight, or a dedicated liability)                                       | P1 (built); the accountant signs                             |
| D4  | **F-9** — the deployment's practice for settling manual-card takings against clearing (a refunded, already-settled card payment leaves a standing clearing credit) | accountant states the practice                               |
| D5  | **F-5 / F-6** — segregation of duties and a receipt-reference rule (options a–d)                                                                                   | (a) detect with Q7 now, decide with the accountant           |
| D6  | **Seeded-history scope:** extend the fixture to create payments (so Tender Totals is exercised) or drive payments through the API                                  | extend the fixture, reviewed                                 |

**Engineering approvals (the 12 pin amendments, the migration and the clock):**

| #   | Approval                                                                                                                    | Category | Recommended |
| --- | --------------------------------------------------------------------------------------------------------------------------- | -------- | ----------- |
| P1  | exactly one extra migration, authorised **by content hash**, and the 11 listing wrappers                                    | A        | approve     |
| P2  | the marked schema block, authorised **by content hash**, and the 7 schema-hash wrappers                                     | B        | approve     |
| P3  | the anonymous credit-note repository admitted as a reviewed journal producer (2 pins)                                       | C        | approve     |
| P4  | the seven credit-note routes as a closed set (N8) — conditional on D1                                                       | D        | approve     |
| P5  | the summary controller as the second user of `@RequireAllBranches` (one exemption in the 3b.10 F file)                      | E        | approve     |
| P6  | the three non-pin edits and the authorised-additions helper                                                                 | —        | approve     |
| P7  | accept that any future change to the migration or the schema block is a **new** approval                                    | —        | accept      |
| P8  | the F-4 controls **as built** (guards + least privilege + `search_path` pin + attribution CHECK) rather than detective-only | —        | approve     |
| P9  | the single-clock change (RB-1 timestamps from the accounting clock)                                                         | —        | approve     |

**Process:** D7 authorise the push and the PR (§5.2) and a fresh OSV scan before merge · D8 assign the independent human reviewer (B6) · D9 decide the
`REVOKE TEMPORARY` hardening (B7) · D10 provide the staging environment, demand input, written criteria and an operator (B4).

### 0.4 Authorisation hashes — recomputed independently (a script that does not import the helper under test)

| What                                                               | Value                                                              | Equal to the pin |
| ------------------------------------------------------------------ | ------------------------------------------------------------------ | ---------------- |
| Migration 50 (`20261105120000_phase_3b_rb1_anonymous_credit_note`) | `c172db11ddc02aeb6c3aa1ac3362c28e45c8872d8f207ef3bcfbc6fbb3e58d00` | yes              |
| `schema.prisma` marked block                                       | `c8ff3ba0649d98c7574e4ffff80e3cf43afa1ef599c22f2c233920988f78b6bf` | yes              |
| `schema.prisma` frozen remainder                                   | `15ef99cee245e0cc64166ab6a5156767b4795a0a7b763435207514945ea37459` | yes (= `HEAD`)   |
| The 49 original migrations                                         | byte-identical to `HEAD`                                           | yes              |

### 0.5 What changed in the frozen-pin area, in one place

12 pin files amended (11 structural + the N8 route pin, which now lists seven closed rows) **plus one reviewed exemption inside the 3b.10 F file** for the
summary controller's use of `@RequireAllBranches`. No frozen expected value was relaxed; each amendment teaches a pin about one reviewed addition. Every
amended pin was **sensitivity-tested** (§ in the pin review). No frozen reporting file is edited by this branch.

### 0.6 Security scan (fresh, on the FINAL tree, run on scratch copies — the worktree was not touched)

Scanner containers ran one at a time, memory-capped, named `flower-scan-*`, after all test stages had finished (no overlap). Copies of the 80 changed files and
the unchanged lockfile were scanned.

| Tool                                              | Result                                                                                                                                                                                                                                                                              |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OSV scanner (lockfile)                            | `pnpm-lock.yaml` (byte-identical to `HEAD`): **765 packages, no issues found**                                                                                                                                                                                                      |
| gitleaks, **CI configuration** (`.gitleaks.toml`) | **no leaks** in the changed files (859 KB scanned; test files are allowlisted by the repository config); the planted random token **was detected** by the identical procedure (`github-pat`) — control valid                                                                        |
| gitleaks, **default rules** (no config)           | **9 findings, all false positives**: the `generic-api-key` rule on `'idempotency-key': 'probe-…'` header literals in `cross-tenant.probe.test.ts`. **None is in lines this branch adds** (0 added lines match; `HEAD` has 22 such lines) and the file is allowlisted by CI's config |
| Trivy `fs` (secrets, misconfig)                   | **0 findings** in the changed files; the planted token **was detected** by the same procedure (CRITICAL `github-pat`) — control valid                                                                                                                                               |
| Trivy `config` (`infra/docker`)                   | **2 LOW** (`DS-0026` no `HEALTHCHECK`, one per Dockerfile); **0 HIGH / CRITICAL**. The Dockerfiles are **unchanged vs `HEAD`** and CI gates this scan on HIGH / CRITICAL only                                                                                                       |
| Secret-custody review                             | no secret in code / fixtures / logs; the new code never reads a credential                                                                                                                                                                                                          |

**Two scanner-tooling glitches, disclosed:** (1) Git Bash rewrote container paths on the first attempt, so none of the five scans ran — a harness error, re-run
with path conversion disabled; (2) Docker Desktop bind mounts intermittently presented an empty source (`scanned ~0 bytes`, planted token **not** detected) —
those runs were **discarded** as invalid, and the gitleaks and Trivy-`fs` results above come from a `docker create` + `docker cp` procedure with no bind mount,
validated by the control in the same procedure. **Last round's summary said "Trivy config 0"; unfiltered, the same unchanged Dockerfiles show the 2 LOW above. I did not keep the earlier invocation, so I cannot say whether it was severity-filtered — treat the unfiltered result as the correct one.**

CI's own `security` job remains the authority; these are local pre-checks and are **not** a substitute for B5.

---

_The sections below are the previous round's evidence. Statements this round found stale are corrected in place and marked **[corrected]**._

## 1. Completed and verified this round

| #   | Item                                                                                                                                                                      | State                            |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| 1   | **F-1 / F-2 — anonymous credit-note SUMMARY** (read-only, 2 routes, no new permission): credit notes, refunds issued / pending / executed / failed, ledger reconciliation | implemented, verified (§2)       |
| 2   | **F-4 — preventive database integrity**: deferred commit-time guards (status ↔ execution journal; note ↔ issuance journal); platform realm read-only; full role inventory | implemented, verified (§3)       |
| 3   | **F-3 / F-5 … F-10** reviewed; sign-off evidence, pending-refund treatment, segregation-of-duties control Q7, cut-off proof                                               | documented, partly tested (§4)   |
| 4   | **Staging seeding plan** and safe benchmark procedure; driver safety limits unchanged; thresholds still unapproved                                                        | planned (§5)                     |
| 5   | The **verified change set (80 files — [corrected] was 72)** and six-commit / PR plan                                                                                      | prepared, nothing committed (§5) |
| 6   | Final verification: focused + full regression, forced static gates, mutation sweep, frozen-pin / migration integrity                                                      | done (§6)                        |

(Earlier rounds, still valid and summarised in the appendices: F3 / F4 / V-1 / V-2 hardening, RB-1 option A2 with its journals and lifecycle, the staging
driver and its safeguards.)

## 2. TASK 1 — Reporting correctness (F-1, F-2)

### 2.1 What was found and what was done

The frozen Sales and Tender Totals reports select **only** their own source kinds by owner ruling and are **byte-hash-frozen** by checkpoints C–F.
Anonymous credit notes are journalled under two **new** kinds the frozen reports never see, so those reports **excluded anonymous credits while the
general ledger included them** (measured: net sales 6 666 / tax 333 in the report, ledger 0 / 0 after a full credit and an attested cash refund).

**Implemented (inside the approved RB-1 scope, no frozen file touched):** `GET /v1/companies/:companyId/anonymous-credit-note-summary` and
`GET /v1/companies/:companyId/branches/:branchId/anonymous-credit-note-summary?from=&to=` — one read statement, one database-enforced read-only
snapshot, explicit tenant + company (+ branch) predicates, exact `TEXT` money, `credit_notes:view` (the company route also needs unrestricted branch
authority), a 90-day cap and a 25 000-note density limit with the frozen reports' own error codes. **It reads only the anonymous tables and exactly two
journal kinds**, and returns, for the period and scope:

- `creditNotes` — count, credited **net ex-tax**, **VAT** and total (VAT is the sale's frozen tax; net-of-discount convention);
- `refundsOfNotesIssuedInPeriod` — **issued / pending / executed / failed**, by method, and the **unallocated credit** still owed;
- `refundsExecutedInPeriod` — the cash-out / attestation lens (by execution-journal date; a manual card by the company-timezone attestation date);
- `pendingRefunds` — unresolved **at the end of the period** (cut-off) and today's **ageing**;
- **`adjustmentsToFrozenReports`** — exactly what to **subtract** from the frozen Sales and Tender figures for the same period and scope (no overlap, so no
  double counting);
- **`reconciliation`** — per-account ledger checks, integrity counts (a note without its journal, an executed cash / bank refund without its journal,
  an orphan journal) and the cumulative `PAYMENT_CLEARING` tie-out; **`reconciled` is true only if every one agrees**.

### 2.2 The requirements, one by one

| Requirement                                                                      | How it is met                                                                                                                                            | Evidence                                                    |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Sales reporting reflects valid anonymous credits **without double counting**     | the frozen Sales figures are unchanged (preserved exactly); the summary holds ONLY the new kinds; `frozen − adjustments` equals the ledger               | before / after test (§2.3); oracle = the company's invoices |
| Tender reporting distinguishes **issued, pending, executed, failed** refunds     | the summary's cohort view by status and method plus the execution-event view; the frozen `refunds` are never mixed with pending / failed lines           | partial / mixed-tender tests                                |
| Reconciliation **never reports success when figures disagree with the ledger**   | `reconciled` ANDs every ledger check and integrity count; a missing journal, a phantom journal, a wrong amount or an unexpected account makes it `false` | 11 unit cases; 2 live bypass tests; all 20 mutants caught   |
| **Historical behaviour and public contracts preserved**                          | no frozen report file, response field, route, pin hash or decision-log row was edited; the frozen figures equal the invoices' own totals                 | frozen-figure assertion; frozen-file audit (§6.3)           |
| **Partial, full, mixed tender, VAT, windows, company / branch isolation** tested | see §2.4                                                                                                                                                 | summary integration suite (10 tests) + unit (11)            |
| **Before / after against the General Ledger**                                    | measured table below                                                                                                                                     | `### GLCMP` output of the before / after test               |

### 2.3 Before / after against the General Ledger (measured, one posting day, AED minor units)

| Figure                     | Frozen report alone | General Ledger | Difference **before** | Summary adjustment | Difference **after** (frozen − adjustment − ledger) |
| -------------------------- | ------------------- | -------------- | --------------------- | ------------------ | --------------------------------------------------- |
| Net sales ex-tax           | 29 997              | 3 333          | **26 664**            | 26 664             | **0**                                               |
| Output tax                 | 1 500               | 167            | **1 333**             | 1 333              | **0**                                               |
| Cash net movement (`CASH`) | 30 497              | 10 500         | **19 997**            | 19 997             | **0**                                               |

The frozen reports' own `reconciled: true` is **not** wrong about the sources they know — it just does not cover the new kinds. The summary's `notice`
says so on every response, and its own `reconciled` covers them.

### 2.4 What was tested (real PostgreSQL, public HTTP routes; expectations from the sales' own invoices and the ledger)

Full refund pending → executed; **partial 1 + 1 + final 1 of 3** (VAT and total sum **exactly** to the invoice; oracle = the frozen floor rule computed in the
test); executed / pending / failed told apart with the unallocated credit exact; **mixed cash + manual card** (a manual card posts nothing but is a tender
movement of the day); **windows** (both bounds inclusive; before / after / single-day; the cumulative cut-off view); **cut-off**: issued on D and attested
on D+2 (advanced application clock) is in flight at the end of D, executed in the period of D+2, every lens reconciled on both sides; **company = Σ branches**,
a branch never sees a sibling, another tenant / a company-restricted caller / a branch-restricted caller refused without disclosure, a cashier refused,
an unauthenticated caller 401; **strict input** (civil dates only, 90-day cap, exact query keys, density 422 without disclosing the count); **other journal
kinds never leak in**; **loud failure** (executed-without-journal and a phantom journal make the summary `reconciled: false`, only for the affected branch
and the company aggregate).

### 2.5 The part that STOPS for the owner — the amendment of the frozen reports (**not applied**)

Folding anonymous credits into the frozen reports' **own** responses changes owner rulings (3b.10-SR, 3b.10-TT / TD: "only these kinds", "exactly these
tables", a journal-anchored period authority) and the hash-frozen files of checkpoints C–F. The exact amendment is in
**`R-1-REPORTING-AMENDMENT-SPEC.md`**: R-1.0 (the summary — implemented), **R-1.1** (Sales only: additive block, a fifth source kind, ~4 hash constants,
pin B literals, the 25 000-document and query-plan gates re-run) and **R-1.2** (Tender too: a different journal shape, **a manual card / other refund
has no journal and therefore no period authority — a policy ruling**, a new table read, the 100 000-movement density guard re-measured).
**Recommendation: R-1.0 for the pilot; R-1.1 after it; R-1.2 only with the authority ruling.**

## 3. TASK 2 — F-4: the EXECUTED-without-journal gap

### 3.1 Who and what can write a refund's status (read from the catalog and the source — not assumed)

| Actor                                                 | Can update `status`?            | Basis                                                                                                                                                                 |
| ----------------------------------------------------- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `flower_app` (tenant-bound, `NOBYPASSRLS`)            | **yes**, 6 outcome columns only | column-level `GRANT UPDATE` (`status`, `reference`, `resolvedAt`, `resolvedByUserId`, `failureReasonCode`, `updatedAt`); `SELECT`, `INSERT`; no `DELETE` / `TRUNCATE` |
| `flower_platform` (cross-tenant, `BYPASSRLS`)         | **no — fixed this round**       | previously inherited `INSERT` + the same `UPDATE`; now `SELECT` only                                                                                                  |
| `flower_migrate` (owner)                              | yes                             | table owner (schema changes); not a runtime path                                                                                                                      |
| database superusers                                   | yes                             | can also disable triggers (`session_replication_role`) — the **residual path**                                                                                        |
| the outbox dispatcher and every other `flower_*` role | no                              | no privilege at all; `PUBLIC` holds none                                                                                                                              |

**Services / code paths:** exactly **two** statements in the whole code base update the table — `AnonymousCreditNoteRepository.executeRefund` and
`.failRefund` (a structural pin asserts it; both now refuse an attestation without an authenticated user); no other module, worker, scheduler or realtime app references it; the Prisma model is never used for writes.

### 3.2 Controls implemented (all inside migration 50; they enforce EXISTING policy and introduce none)

1. **Deferred commit-time guard on the refund `status`:** a `CASH` / `BANK_TRANSFER` refund can become `EXECUTED` only if exactly **one sealed
   execution journal with exactly the two expected lines** exists (`Dr ASSET.PAYMENT_CLEARING` / `Cr ASSET.CASH_ON_HAND | ASSET.BANK`, for the refund
   amount); a **manual card / other, FAILED or PENDING** refund must have **no** execution journal.
2. **Deferred guard on the credit note:** a note cannot commit without its **one sealed issuance journal**, exactly `Dr REVENUE.SALES (total − tax) ·
Dr LIABILITY.TAX_PAYABLE (tax) / Cr ASSET.PAYMENT_CLEARING (total)`.
3. **Least privilege:** the platform realm is read-only on the three tables; the application role is the only runtime writer.
4. **Application:** status, journal and audit row are written in **one transaction** (unchanged); **[corrected]** the document, journal and outcome timestamps
   — including the credit note's and its lines' `createdAt` — come from the one accounting clock; an attestation without an authenticated user is refused
   (`403 ATTESTER_REQUIRED`).
5. **[added after the independent review] `search_path = public, pg_temp` on all 8 guard functions** (a session's temporary tables are otherwise searched
   first, and the tenant-bound role could shadow `journal_entry` / `journal_line` / `account` with forged temp tables — demonstrated, then fixed, IV-1); no
   `SECURITY DEFINER` anywhere; **a state CHECK requiring the attester** for `EXECUTED` / `FAILED` and forbidding one on `PENDING` (IV-2).
6. **Detective:** the sub-ledger ↔ `PAYMENT_CLEARING` reconciliation (Q3 and the summary) and the orphan / missing-journal integrity counts catch the one
   path a trigger cannot (a superuser disabling triggers).

### 3.3 Tests (negative and bypass) — `anonymous-credit-note.integrity.integration.test.ts`, **[corrected] 15 tests** (10 original + SHADOWING ×2, ATTRIBUTION, SINGLE CLOCK, F-9 worked example), real PostgreSQL

Role / privilege inventory from the catalog (exact sets); **application-role bypass** (direct `EXECUTED` without a journal → rejected at commit, row stays
`PENDING`; also as a superuser with triggers on); **wrong-shape journals** — wrong account, one unit short, an extra balancing line, reversed direction —
all rejected, the **exact genuine shape accepted** (a check, not a wall); a journal for a **FAILED** or **manual-card** refund rejected, and a manual card
`EXECUTED` with no journal allowed; the app role cannot change an amount, delete, or insert a refund born `EXECUTED`; **the platform realm cannot write**;
another tenant's session cannot touch the row (RLS: 0 rows); **issuance** — no journal / wrong journal rejected, the exact journal accepted; **parity** of
the database's tender → account pairs with the application's frozen mapping; **8 concurrent executions → exactly one 200, seven 409, one journal, one
audit row**; **application atomicity** — a closed accounting period rolls back status, journal and audit together and the refund can still be attested
after reopening; **residual** — a superuser with triggers disabled _can_ set `EXECUTED`, and Q3 reports exactly that amount.
**Mutation evidence:** T1–T6 (guard shape, no-journal rule, status guard, platform grant, issuance guard, trigger column) — **6 / 6 caught**; **[added]** T7–T12
(attribution CHECK, the two `search_path` pins, the note / line `createdAt` clock) and X1–X8 (further summary / reconciliation mutants) — all caught; the
mutants that initially survived (X2, T9) were closed by strengthening tests, not by changing the mutants.

### 3.4 Preserved / not changed

Append-only accounting (no journal table or trigger edited; the guards only **read** journals), the transaction contracts, the frozen posting engine and
every existing migration. **No new accounting policy:** the guards check the shape the application already posts. **Residual risk (stated):** a superuser /
table owner can disable triggers; mitigated by detective Q3, by not using those roles at runtime, and by audit.

## 4. TASK 3 — Remaining findings (F-3, F-5 … F-10)

### 4.1 Status and classification

| Id   | Finding                                                         | State after this round                                                                                                                                                                                                                                                                                                                                                                                                               | Class                                                               |
| ---- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| F-1  | Frozen Sales report excludes anonymous credits                  | **mitigated** by the summary (measured, ledger-reconciled); frozen amendment stopped for the owner                                                                                                                                                                                                                                                                                                                                   | **Phase 3 release: decision R-1** (R-1.0 suffices for the pilot)    |
| F-2  | Frozen Tender Totals excludes anonymous refunds                 | same; manual card / other need an authority ruling for any frozen change                                                                                                                                                                                                                                                                                                                                                             | **Phase 3 release: decision R-1**                                   |
| F-3  | `PAYMENT_CLEARING` carries a credit while refunds are in flight | documented with exact entries for P1 (built) and P2 (alternative): `RB-1-PENDING-REFUND-TREATMENT.md`                                                                                                                                                                                                                                                                                                                                | **Phase 3 release: accountant decision S3**                         |
| F-4  | the database did not couple `EXECUTED` to its journal           | **fixed** (§3)                                                                                                                                                                                                                                                                                                                                                                                                                       | **Phase 3 release — done**                                          |
| F-5  | no segregation of duties                                        | fact + detective **Q7** (tested); options (a)–(d) in the treatment document                                                                                                                                                                                                                                                                                                                                                          | **Phase 3 release: owner / accountant decision S9** (code optional) |
| F-6  | attestation is a human claim; `reference` optional              | unchanged by design; "require a reference for CASH / BANK" is a DTO rule                                                                                                                                                                                                                                                                                                                                                             | **Phase 3 release: decision with S9**                               |
| F-7  | no list / ageing route                                          | **mitigated:** the summary carries counts, amounts and **ageing**; Q1 / Q2 give the lines                                                                                                                                                                                                                                                                                                                                            | **Deferred** (a per-line endpoint) — post-pilot follow-up           |
| F-8  | period-end cut-off                                              | **proved** with real data (cut-off test) and a close procedure (treatment doc §3)                                                                                                                                                                                                                                                                                                                                                    | **Phase 3 release: accountant procedure S6**                        |
| F-9  | manual card refund posts nothing — settlement interaction       | **[corrected] now measured by a test (worked example E3, `RB-1-ACCOUNTANT-RECONCILIATION-PACKAGE.md` §5), with the settlement journal _emulated_ in the shape of the frozen batch finalisation (not the frozen code):** a refunded, already-settled manual card payment leaves a **standing credit on `PAYMENT_CLEARING`** that no frozen flow clears (settlement lines have a closed `SETTLEMENT` kind); an unsettled one nets to 0 | **Phase 3 release: accountant confirmation S4**                     |
| F-10 | no inventory / COGS effect                                      | the Phase 3B schema has **no inventory ledger**; a credit reverses revenue and tax only                                                                                                                                                                                                                                                                                                                                              | **Formally deferred — Phase 5 (inventory)**; re-review required     |
| —    | cash-drawer reconciliation of attested cash refunds             | manual until Phase 4 (Q5 daily); no hook invented                                                                                                                                                                                                                                                                                                                                                                                    | **Formally deferred — Phase 4 (cash register)**                     |

### 4.2 Accountant sign-off evidence — criteria S1–S13 (each is checkable)

| #   | Criterion                                                                                                                      | Evidence                                                                                         |
| --- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| S1  | the five accounts and the net-of-discount convention are acceptable; no new account                                            | Appendix A; trial balance at each stage                                                          |
| S2  | journals J1–J4 correct on three samples (full cash, mixed partial, failed-then-replaced)                                       | ledger-oracle test (Appendix A)                                                                  |
| S3  | **P1 or P2** for pending refunds recorded                                                                                      | `RB-1-PENDING-REFUND-TREATMENT.md` §1–2 (measured example, exact P2 entries)                     |
| S4  | manual card / other posting nothing accepted, **including the settled-card case**                                              | treatment doc §4 (code reading) — **the accountant states the deployment's settlement practice** |
| S5  | VAT = the sale's frozen tax; floor-proportional partials with an exact final remainder; tax-inclusive; document-discount share | partial-refund summary test, property test, oracle                                               |
| S6  | **period-end procedure**: Q1, Q2, `pendingRefunds.atPeriodEnd`, summary `reconciled`                                           | cut-off test; treatment doc §3                                                                   |
| S7  | **Q3 difference = 0** and summary `reconciled = true` at every close; Q4 ties to the trial balance                             | Q3, Q4, summary                                                                                  |
| S8  | reporting decision **R-1** (R-1.0 / R-1.1 / R-1.2)                                                                             | §2.5, `R-1-REPORTING-AMENDMENT-SPEC.md`; before / after table §2.3                               |
| S9  | segregation-of-duties decision (options a–d)                                                                                   | Q7; treatment doc §5                                                                             |
| S10 | cash-drawer procedure until Phase 4 (daily count against Q5)                                                                   | Q5                                                                                               |
| S11 | posting-date policy: issuance on the issue date, execution on the attestation date; a closed period refuses and rolls back     | closed-period and atomicity tests                                                                |
| S12 | F-4 controls accepted: preventive guards + detective Q3 + the stated residual (superuser)                                      | §3                                                                                               |
| S13 | a **sample run on realistic data** reviewed with Q1–Q7 and the summary                                                         | to be produced at pilot                                                                          |

Sign-off record template: accountant · role · date · P1 / P2 · S1–S13 each _accepted / accepted with procedure / rejected_ · R-1 · segregation decision ·
close-procedure owner · conditions · signature.

## 5. TASK 4 — Performance and CI readiness

### 5.1 Performance (limits unchanged; nothing invented)

- **Driver safety limits preserved:** `ALLOW_FINANCIAL_WRITES=yes`, https-or-localhost, typed `CONFIRM_TARGET_HOST`, `MAX_DOCUMENTS` (warm-up counted), `DRY_RUN`;
  20 tests (19 unit + 1 real-HTTP compatibility) and 5 / 5 safeguard mutants caught — **no change this round**.
- **Seeding plan and safe procedure:** `HG3B-STAGING-SEEDING-PLAN.md` — layer A through the real API (structure), layer B by the existing **set-based SQL
  fixture** behind a new CLI with typed-host / marker-row safeguards (ledger volume only; it does not prove posting), a fingerprint so "restored to a known
  dataset" is checkable, a 12-step procedure with stop conditions, and the honest list of what must still be built or provided. **No tool, environment or
  result exists.**
- **Thresholds:** p95 ≤ 1 s, p99 ≤ 2 s, ≥ 3 sales/s/company remain **PROPOSED, NOT APPROVED**; the T2 measurement point is undecided (spec §9.1, §11 unchanged).

### 5.2 The verified change set and the six-commit plan (**proposed only — nothing committed**)

**[corrected]** The **80 changed or new files** (`git status -uall`; 59 default entries because the new directories collapse) partition **exactly** —
3 + 17 + 4 + 35 + 6 + 15 = 80, no overlap, none uncovered (re-counted by listing on the final tree; commit 6 grew from 7 to 15 files because this round added
eight documents / amendment artefacts). Conventional Commits; every message ends with the repository trailers
(`Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>` and `Claude-Session: <session url>`); linear history, no force-push.

| #   | Commit message                                                                                                                                                        | Files | Contents                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `feat(db): throw a typed InvalidScopeIdError from runScoped`                                                                                                          | 3     | `packages/db/src/{index,scoped}.ts`, `packages/db/test/scoped-invalid-id.test.ts`                                                                                                                                                                                                                                                                                                                                                              |
| 2   | `fix(api): constrain malformed ids, cursors and params; reject card numbers in free text (F3, F4, V-1, V-2)`                                                          | 17    | `common/validation/*` (+ tests), `audit.module.ts`, `policy.service.ts`, the customer / localization / order / platform-audit / tenant-config / settlement-batch controllers, `plan.repository.ts`                                                                                                                                                                                                                                             |
| 3   | `test(verification): P6f zero-5xx, route-hardening sweep and fixture-identity pin`                                                                                    | 4     | `task-3b11-pci-bounded-negative.test.ts`, `route-hardening-sweep.integration.test.ts`, `fixture-identity.structural.test.ts`, `load-sale-world.ts`                                                                                                                                                                                                                                                                                             |
| 4   | `feat(api): anonymous credit notes, refunds, integrity guards and ledger-reconciled summary (RB-1 A2, migration 50)`                                                  | 35    | the migration, the `schema.prisma` block, `modules/anonymous-credit-notes/*` (incl. the summary and all integration suites), `actions.ts`, `settlements.module.ts`, the authorised-additions helper + pin, the **12 pin amendments**, the probe entries, `RB-1-ACCOUNTANT-CONTROL-QUERIES.sql` (read by a test)                                                                                                                                |
| 5   | `feat(api): staging sale-latency load driver with safeguards`                                                                                                         | 6     | `staging-benchmark/*`: cli, core, driver, safeguards, unit tests, real-HTTP compatibility test                                                                                                                                                                                                                                                                                                                                                 |
| 6   | `docs(phase-3): closure decision gate — evidence, RB-1 proposal and treatment, accountant package, R-1 specs and R-1.1 trial artefacts, pin review, performance plan` | 15    | the 7 earlier documents **plus** `PHASE-3B-PIN-AMENDMENT-REVIEW.md`, `RB-1-INDEPENDENT-VERIFICATION-AND-TRUST.md`, `RB-1-ACCOUNTANT-RECONCILIATION-PACKAGE.md`, `R-1.2-TENDER-REPORT-RECOMMENDATION.md`, `HG3B-PERFORMANCE-DECISION-SHEET.md` and `amendments/R-1.1/{R-1.1-sales-report.patch, r11-demonstration.integration.test.ts.txt, measured-outputs.txt}` (the trial artefacts are text records, **not executed code and not applied**) |

**Honest limit:** CI judges the PR head; **commits 1–5 are not individually proven green — only the tip is verified.** Commit 4 is large because the
feature, its migration, its guards and its summary are one reviewable unit with one pinned hash; commit 3 depends on commit 2.

**PR plan (unchanged; needs your separate approval):** `git push -u origin phase-3/3b-closure-hardening`, one PR into `main`, CI on the PR head
(`verify`, `e2e`, `realtime`, `security`), merge only when all four are green on the PR head after a fresh OSV scan, fast-forward only, **no tag**.
**The green `main` run `42795556220` is not evidence for this branch.**

## 6. TASK 5 — Final verification

### 6.1 Results (sequential, single worker, `--max-old-space-size=1536`) — **[corrected] these are the PREVIOUS round's figures, kept for history. The authoritative final-tree results are in §0.0 (API 4,097 passed / 11 skipped — i.e. these 4,092 plus the 5 new integrity tests; DB 793; packages 984; RLS spike 21; all static gates exit 0).**

**A. `apps/api` — 177 test files (174 passed + 3 opt-in files skipped), 12 sequential groups: 4,092 passed, 11 skipped, 0 failed in the final state.**

| Group                                                                                                                                  | Files   | Tests passed                  | Result                                                           |
| -------------------------------------------------------------------------------------------------------------------------------------- | ------- | ----------------------------- | ---------------------------------------------------------------- |
| G01 common, health, config                                                                                                             | 16      | 145                           | green                                                            |
| G02 access, identity, org, secrets, platform                                                                                           | 13      | 130                           | green                                                            |
| G03 customers, localization                                                                                                            | 8       | 158                           | green                                                            |
| G04 catalog                                                                                                                            | 17      | 323                           | green                                                            |
| G05 orders (incl. the amended N8 route pin, now 7 closed rows)                                                                         | 10      | 464                           | green                                                            |
| G06 sales                                                                                                                              | 15      | 819                           | green                                                            |
| G07 payments                                                                                                                           | 18      | 326                           | green                                                            |
| G08 receivables                                                                                                                        | 23      | 387                           | green                                                            |
| G09 settlements, **anonymous-credit-notes (5 files)**, staging-benchmark                                                               | 11      | 212                           | green (re-run after the last edit: 212)                          |
| G10 accounting                                                                                                                         | 6       | 68                            | green                                                            |
| G11 reporting (incl. the six 3b.10 structural pins)                                                                                    | 28      | 966                           | **first run 4 failures — fixed — full re-run green** (2 skipped) |
| G12 verification (PCI, Phase 3 exit scenario, sweep, authorised-additions pin, fixture pin) + cross-tenant and branch-isolation probes | 12      | 94                            | green (3 files / 9 tests skipped: opt-in `G_LOAD`)               |
| **Total**                                                                                                                              | **177** | **4,092 passed + 11 skipped** | **0 failed**                                                     |

**The four failures of the first G11 run, in full.** All four were frozen 3b.10 pins, and all four were caused by my own new code, not by instability:
(1–3) pins **A, B, C** ("nothing outside the reporting module references …") failed because my new structural test **named frozen report files and
classes literally**; fixed by listing the reporting directory dynamically instead of naming files (so the pin cannot go stale and trips no scan);
(4) pin **F** ("`@RequireAllBranches` is used by the report controllers only") failed because the company-wide summary route uses it; fixed by **one reviewed,
explicit exemption for the summary controller** in the 3b.10 F file (that file now carries one further reviewed assertion; the number of amended pin files
stays 12). I did **not** evade the pin by setting the decorator's metadata key directly. The six 3b.10 pins plus my structural pin were then re-run
(7 files, 422 passed) and **G11 was re-run in full: 28 files, 966 passed, 2 skipped.** A separate lint finding (a sixth `no-console` warning, from a
`console.log` in my summary test) was fixed by writing to stdout directly; lint is back to the 5 pre-existing waived warnings.

**B. `@flower/db` — all 20 test files, 6 sequential groups, 793 passed, 0 failed** (the RLS / isolation `migration.test` 130; 3b.8 provenance / refund /
currency-release 253; closure + permission + refund-scope migrations + accounting 78; customer, numbering, payments-core, scoped-invalid-id 160; receivables 70;
safe-logging, sale-tax, settlement 102) — **run against the edited migration 50 (F-4 guards, read-only platform grant)**.

**C. Every other CI-executed package, re-run one at a time on the final tree, all exit 0:** money 50 · uom 74 · shared-types 38 · i18n 4 · permissions 29 ·
safe-logging 40 · service-runtime 7 · api-client 18 · realtime-client 21 · ui 3 · config 491 · backend 20 · testing 16 · scheduler 12 · worker 97 · realtime 60 ·
pos-pwa 4 — **984 tests in 57 files** — plus the PgBouncer RLS spike `tooling/spikes/rls` **21 / 21**; customer-web, owner-web and super-admin-web have no test files.

**D. Focused financial / reporting / security / RLS suites of this round (all inside A–C):** RB-1 module **62** (plan 11 · summary unit 11 · main integration 20 ·
**F-4 integrity 10** · **summary integration 10**); the six 3b.10 + five 3b.9 structural pins and the authorised-additions pin (16 tests); the cross-tenant and
branch-isolation probes; the route-hardening sweep and the PCI bounded-negative suite; the Phase 3 exit scenario; the RLS suite (`migration.test`, 130).

**E. Static gates (forced, cache bypassed, concurrency 1) on the final tree:** `typecheck` **36 / 36**; `lint` **37 / 37, 0 errors** (the only warnings are the 5
pre-existing waived `no-console` in `scripts/reconcile-historical-settlements.ts`); `build` **22 / 22**; `@flower/config test:negative` passed; `prettier --check`
clean. After the last test edit, API `eslint`, `tsc --noEmit`, `prettier --check` and the anonymous-module group were re-run: clean, 212 / 212.

**F. Skips and exclusions (never counted as passed):** 3 files / 9 tests = the opt-in `G_LOAD` Checkpoint G files; 2 opt-in 100 000-record density tests.
**Not run locally:** Playwright e2e and the CI `security` job itself. **[corrected]** OSV, gitleaks and Trivy _were_ run locally this round on scratch copies (§0.6) as pre-checks. A pattern scan of every changed file for private keys and cloud / GitHub / Slack tokens
found **nothing**.

### 6.2 Mutation evidence (each mutant applied to real code, tests run, file restored from a byte backup with a hash check)

| Group                                                                                        | Result                                                                                                                                                                         |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| RB-1 plan / repository / service / controller / DB guards (P1–P7, R1–R7, S1, C1, D1–D3, R5b) | all caught (R5 an explained redundancy; R2 / D2 / D3 initially survived and were fixed by strengthening tests)                                                                 |
| **F-4 database controls (T1–T6)**                                                            | **6 / 6 caught**                                                                                                                                                               |
| **Summary logic (U1–U7)**                                                                    | **7 / 7 caught**                                                                                                                                                               |
| **Summary SQL (Q1–Q7)**                                                                      | **7 / 7 caught** — Q6 (dropping the two-source-kind filter) **initially survived** because no other-kind journal touched an unusual account; a test was added and it is caught |
| Staging driver safeguards (G1–G5)                                                            | 5 / 5 caught                                                                                                                                                                   |

### 6.3 Frozen pins and migration integrity

- **Pinned files unchanged vs `HEAD`:** `app.module`, `pipeline.module`, `idempotency.module`, `permission.guard`, `all-exceptions.filter`, `policy-engine`,
  `policy.types`, `system-roles`; **every frozen reporting file** (`sales-financial-report.*`, `tender-totals-report.*`, `reporting.module.ts`, the
  checkpoint A–F production files) is byte-identical to `HEAD` (a structural pin asserts the feature never references them).
- **Migrations:** exactly **one added** (the 50th); the 49 originals proven byte-identical by the 12 amended pins; **the 50th's content hash is re-pinned**
  **[corrected: re-pinned a second time after the independent review — `search_path` pin on every guard function, attribution CHECK]**
  `c172db11ddc02aeb6c3aa1ac3362c28e45c8872d8f207ef3bcfbc6fbb3e58d00` (previous value `d12edf2b…b242`; additive-only SQL proven statement by statement; the F-4
  guards, grants, `search_path` clause on every function and the attribution CHECK pinned by their own assertions). `schema.prisma` differs only by the marked block (frozen part still `15ef99ce…`).
- **Permissions:** no change to `packages/permissions`, role templates or the policy engine; no new key (`credit_notes:view` / `issue`, `refunds:execute`).
- **Pins amended (all reviewed, mechanical):** the 11 structural pins and N8 (now 7 closed rows: 5 + 2 read-only summary routes) — **12 pin amendments, unchanged
  in number**. **New this round, inside the existing 3b.10 F file:** one reviewed exemption admitting the summary controller as a second user of
  `@RequireAllBranches` (the decorator stays reserved otherwise; `@RequireAllPermissions` stays reserved for report controllers). Also: the cross-tenant probe
  (+2 prefixes) and my own authorised-additions pin (+2 tests: F-4 grants / guards, summary read-only).
- **Dependencies, lockfile, workspace, workflows, `turbo.json`:** unchanged. Secrets scan: see §6.1.

## 7. Release blockers

**[corrected] Superseded by the checklist in §0.2 (B1–B7); the four items below remain true and are a subset.**

1. **Accountant sign-off** (S1–S13) — mandatory before RB-1 is enabled for real tenants.
2. **Owner decisions** (§8).
3. **HG3b-SALE-LATENCY:** no staging environment, no seeding tool, no approved criteria, no demand input, no independent driver review.
4. **HG3b-CI:** the branch has never run in GitHub CI; the security and e2e jobs can only run there.

## 8. Owner decisions (consolidated; recommended default beside each)

**[corrected] The authoritative, numbered package is §0.3 (D1–D10, P1–P9). This table is the previous round's list, kept for traceability; where they differ,
§0.3 governs. Row 2 now reads "approve the F-4 controls as built, including the `search_path` pin and the attribution CHECK, and the re-pin to `c172db11…8d00`".**

| #   | Decision                                                                                                                                    | Recommended default                      |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| 1   | **R-1:** keep the summary (R-1.0) for the pilot; schedule R-1.1 (Sales) after it; R-1.2 (Tender) only with the manual-card authority ruling | R-1.0 now; R-1.1 later; defer R-1.2      |
| 2   | Approve the F-4 controls as built (edits to the unshipped migration 50 and its re-pinned hash) — or revert to detective-only                | approve                                  |
| 3   | Approve the single-clock change (documents' timestamps from the accounting clock)                                                           | approve                                  |
| 4   | Status of a fully reversed order (D1): unchanged now; approve read-only reversal fields next                                                | A, then C                                |
| 5   | Cash refund / Phase 4 drawer (D2): manual until Phase 4 with Q5 daily; record the Phase 4 requirement                                       | A + record                               |
| 6   | Interim restrictions (D3): none in code; gate production enablement on sign-off                                                             | A + C                                    |
| 7   | F3 policy (D4): reject with 400                                                                                                             | reject                                   |
| 8   | Module registration (D5): keep (via `AuditModule` / `SettlementsModule`)                                                                    | keep                                     |
| 9   | The 12 pin amendments + helper (D6)                                                                                                         | approve as mechanical                    |
| 10  | **F-5 / F-6** segregation of duties and receipt-reference rule — options (a)–(d)                                                            | (a) with Q7, decided with the accountant |
| 11  | `PAYMENT_CLEARING` (P1) or a dedicated liability (P2)                                                                                       | P1, sign-off at pilot                    |
| 12  | **F-9** the accountant's statement on settling manual card takings against clearing                                                         | accountant                               |
| 13  | Latency: environment, demand, criteria (incl. the T2 point), seeding tool, driver review, operator                                          | spec §11, seeding plan §6                |
| 14  | Authorise the push and PR (§5.2), and a fresh OSV scan before merge                                                                         | approve when 1–12 are recorded           |

## 9. Exact final closure checklist

| #   | Requirement                                                                                | State                                                                      |
| --- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| 1   | F3 / F4 / V-1 / V-2 fixed and verified; PCI bounded evidence                               | ✅ done                                                                    |
| 2   | RB-1 implemented per owner decisions, audited, mutation-proven                             | ✅ done locally                                                            |
| 3   | **F-1 / F-2** ledger-reconciled reporting (summary) with before / after against the ledger | ✅ done                                                                    |
| 4   | **F-4** preventive + detective database integrity, with bypass tests                       | ✅ done                                                                    |
| 5   | Frozen-report amendment R-1.1 / R-1.2                                                      | ⏸ **stopped for owner approval**                                           |
| 6   | **Accountant sign-off** S1–S13                                                             | ❌ **OPEN**                                                                |
| 7   | Owner decisions of §8                                                                      | ❌ OPEN                                                                    |
| 8   | Full local regression, all CI-executed test packages, forced static gates, mutation sweep  | ✅ re-run on the final tree (§0.0); mutation sweeps from the previous tree |
| 9   | Frozen-file / permission / dependency / migration / secret audit                           | ✅ done (§6.3) — 80 files, 0 frozen file changed                           |
| 10  | Staging driver, safeguards, post-run SQL, seeding plan                                     | ✅ written / ❌ not reviewed, not run                                      |
| 11  | **HG3b-SALE-LATENCY** run on a representative environment against approved criteria        | ❌ **OPEN**                                                                |
| 12  | **HG3b-CI** green on this branch (verify, e2e, realtime, security, fresh OSV)              | ❌ **OPEN** (not pushed)                                                   |
| 13  | `phase-3-complete` tag and the STOP-and-approve gate                                       | ❌ **must not be created yet**                                             |

**Final closure readiness: NOT READY.** Items 5, 6, 7, 11 and 12 are open.

## 10. Recommended next actions (in order)

1. **Owner:** decide §8 items 1–12 (the safest defaults are stated; none changes an owner ruling except by your explicit approval).
2. **Owner:** approve the push and the PR (§5.2) — the only way to get CI evidence, and the build the latency run needs.
3. **Accountant:** review `RB-1-PENDING-REFUND-TREATMENT.md`, §4.2 and Q1–Q7; return the sign-off record.
4. **Owner + infrastructure:** provide the staging environment and demand input; approve the criteria; commission the seeding CLI and an independent driver review.
5. **After CI is green and decisions are recorded:** run the latency campaign and request the Phase 3B closure decision.
6. **Follow-ups (not blockers):** R-1.1; read-only reversal fields; a per-line pending-refund list; second-person attestation if chosen; the Phase 4 drawer hook;
   inventory / COGS reversal with the inventory phase; explicit module registration after closure.

---

## Appendix A — RB-1 financial audit (previous round; still valid)

**Journal catalogue (the only postings RB-1 makes):**

| Id  | Event                                     | Source key (`sourceKind` / `sourceId`)     | Lines                                                                                                     |
| --- | ----------------------------------------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| J1  | Credit note **issued**                    | `anonymous_credit_note` / note id          | Dr `REVENUE.SALES` (total − tax) · Dr `LIABILITY.TAX_PAYABLE` (tax) / Cr `ASSET.PAYMENT_CLEARING` (total) |
| J2  | **CASH** refund attested                  | `anonymous_credit_note_refund` / refund id | Dr `ASSET.PAYMENT_CLEARING` / Cr `ASSET.CASH_ON_HAND`                                                     |
| J3  | **BANK_TRANSFER** refund attested         | same                                       | Dr `ASSET.PAYMENT_CLEARING` / Cr `ASSET.BANK`                                                             |
| J4  | **CARD_TERMINAL / OTHER_MANUAL** attested | —                                          | **no journal** (the sale debited clearing; J1's credit is the final effect)                               |
| —   | refund **failed** / replacement **added** | —                                          | **no journal**                                                                                            |

**Idempotency — four layers:** the HTTP `Idempotency-Key` (4 scopes); the journal's unique `sourceKind + sourceId`; the DB triggers (caps, terminal states, and
now the F-4 commit-time guards); and row locks (order → invoice → lines → counter).

**Refund lifecycle verified at every state** (ledger oracle, read from the journal tables): S0 issued (all PENDING) → revenue +subtotal, tax +tax, clearing −total;
S1 CASH attested → cash −cash, clearing −card amount; S2 a line FAILED → unchanged (unallocated = the failed amount); S3 replacement attested → unchanged
(manual card posts nothing). End state: **the sale journal plus the credit-note journals net to exactly 0 on every account**. Every journal balances.

**Identities:** VAT from the sale's frozen line snapshot, floor-proportional partials, the exhausting credit takes the exact remainder (app + DB trigger);
per-tender caps (a card payment is never refunded as cash; app + DB); sub-ledger ↔ `PAYMENT_CLEARING` reconciliation difference 0 over every legitimate flow; the
original sale is byte-identical after a credit.

## Appendix B — Business decision package (previous round; recommendations unchanged)

| Decision                            | Safest default (recommended)                                                                                                                                             | Operational implication                                                                               |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| D1 status of a fully reversed order | **A** leave order / invoice unchanged; then **C** (read-only reversal fields). Not B (`CANCELLED`): it mutates frozen records and collides with the frozen walk-in guard | until C or R-1.1, a manager uses the credit note, the summary or Q6 to see a reversal                 |
| D2 cash refund and Phase 4 drawer   | **A** manual until Phase 4 (attest only when cash has physically left a counted till; reference recorded; Q5 daily); record the Phase 4 payout requirement               | a till variance is possible until Phase 4                                                             |
| D3 interim production restrictions  | **A + C**: none in code (permission-gated: owner / admin / manager / accountant + step-up); do not enable for real tenants before sign-off                               | no kill switch; the Walk-in-Customer workaround stays not adopted                                     |
| D4 F3 sensitive-data policy         | **A** reject with `400 SENSITIVE_DATA_REJECTED`                                                                                                                          | a Luhn-valid 13–19-digit reference typed into a free-text field is refused; the value is never echoed |
| D5 module registration              | **A** keep: `InputHardeningModule` via `AuditModule`, the anonymous module via `SettlementsModule` (zero edits to hash-pinned files)                                     | indirect but pinned: the route sweep and a structural pin fail if either registration disappears      |
| D6 the frozen-pin amendments        | **approve all 12** as mechanical                                                                                                                                         | Phase 4's merge reconciles its migration-row-count pins and `frozen-baseline.ts` with the helper      |

**The 12 pin amendments (11 structural + N8) — every frozen expected value unchanged:** 3b.9 B, C, D (migration listing via `withoutAuthorizedMigrations`); 3b.9 E
(2 listings); 3b.9 F (3 listings + schema hash via `frozenSchemaShaOfFile`); 3b.10 A, B, C, F (listing + schema hash); 3b.10 D and E (listing + schema hash + one
reviewed entry in the closed set of journal producers); **N8** of the orders integration suite (the reviewed anonymous routes as an exact closed set — now 7:
the five RB-1 routes and the two read-only summary routes — while every other route still obeys the frozen "nothing else carries a credit-note / refund path or
permission" rules). Not pins: the cross-tenant probe entries, the P6f / PCI test, the optional `userId` of `load-sale-world.ts`.
