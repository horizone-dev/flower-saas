# CI baseline — review checklists for PR #51, #45, #46 and #47 (2026-11-18)

**Nothing here is approved, merged or applied.** The owner has **not** authorised merging #45, #47 or #51 and has **not** authorised the picomatch exception. This file is what a reviewer needs in order to decide. Every statement below was re-checked on 2026-11-18 against the PR heads named in the table.

> **Correction, 2026-11-18 16:10 UTC (supersedes every picomatch statement below and in the sequence doc §6).** The OSV/GitHub advisory `GHSA-fc5q-39xc-vjpf` (picomatch ReDoS) was **withdrawn on 2026-11-18 at 15:38 UTC**, after the checks in the table ran. The withdrawal follows an upstream dispute: the picomatch maintainer called it "not a vulnerability" and closed the fix PR. **No patched picomatch release exists and the code is unchanged**; the advisory text itself is garbled, so the reviewer should read the upstream thread. Re-measured with osv-scanner v2.5.1 on #45's lockfile, no config: **"No issues found", exit 0**. Consequences: the **picomatch exception is not needed and must not be created**; the only blocker in the `security` job's osv step is the two Next advisories, which **#45 alone removes**; #46 becomes a record (merge or close: the owner decides). Advisory data can change again: re-run the scan on the day of any merge.

| PR  | Head      | Change                                                      | `verify`                              | `security`                                                                                                               | `e2e` / `realtime` | Reviews |
| --- | --------- | ----------------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------ | ------- |
| #51 | `827e797` | 1 line: API test stack PostgreSQL `17` → `17.11`            | **pass**                              | fail (osv: 2 Next + picomatch)                                                                                           | pass / pass        | 0       |
| #45 | `7abcdad` | `next` 16.4.1 → 16.4.6 in 4 apps + lockfile                 | fail (only the PG 17.12 report files) | **pass on the re-run** (osv, gitleaks, Trivy ×2; the original run failed only on the since-withdrawn picomatch advisory) | pass / pass        | 0       |
| #46 | `e7a2352` | 1 docs file: picomatch risk assessment + exception proposal | fail (same)                           | fail (osv)                                                                                                               | pass / pass        | 0       |
| #47 | `7edf2ff` | `.gitleaks.toml` +27 lines, two scoped exceptions           | fail (same)                           | fail (osv: the two Next advisories; gitleaks/Trivy **skipped**)                                                          | pass / pass        | 0       |

The `security` cells record the runs as they were. They predate the picomatch withdrawal, so a re-run now fails on those branches **only** on the two Next advisories (#45's re-run, which has the Next fix, passes the whole job). `verify` cells are unchanged by it.

`main` has no branch protection and no CODEOWNERS, so "approved before merge" is a **process rule, not a technical block**: nothing prevents a merge without review. The reviewer list below is therefore the only control.

## What "independent" means here

All four PRs were authored by Claude on the owner's instruction. An **independent** reviewer is a named human who did not write or request the change and can read a diff of this kind. **No security reviewer, accountant or database reviewer is named anywhere in the repository or the owner decisions.** Naming them is the first release blocker that engineering cannot remove.

## #51 — PostgreSQL 17.11 pin (a temporary reproducibility measure, not a fix)

**Why it exists.** With `postgres:17` resolving to 17.12, 10 tests in three frozen report suites fail (`sales-financial-report.query-plan` ×6, `tender-totals-report.dense-window` ×2, `sales-financial-report.dense-window` ×2 on most branches). The same code passes on 17.11. The cause is a plan regression (Finding A in PR #50), **not** a test defect. The pin makes the tests reproducible; it does **not** make the production query faster on 17.12.

Reviewer checklist (database reviewer or owner):

1. The diff is exactly `postgres: 'postgres:17'` → `postgres: 'postgres:17.11'` in `packages/testing/src/containers.ts`, one line.
2. `verify` is green on #51 and red only in the three named files on every other PR (re-checked today: #45, #46, #47, #50 red; #51 green).
3. PR #50's evidence (17.11 vs 17.12 plan comparison) is **kept**. The frozen tests are **not** weakened, skipped or re-baselined.
4. **Production and staging do not inherit the pin.** `infra/staging/docker-compose.staging.yml` still says `image: postgres:17` in two services (floating tag). The staging PostgreSQL version must be pinned deliberately (see `STAGING-DEPLOYMENT-CHECKLIST.md` §2). Until Finding A is fixed, **do not run production on 17.12 without the report limits in place**.
5. Record an exit condition: remove the pin when Finding A is fixed (a query or index change, separately reviewed) or a PostgreSQL release restores the plan.

Approval required: **owner decision** (accept a test-only pin with Finding A still open). Merge dependency: none; merge first so every later branch can turn `verify` green after taking `main` in.

## #45 — Next.js 16.4.6

Reviewer checklist (security reviewer):

1. Only `next` 16.4.1 → 16.4.6 in `apps/{customer-web,owner-web,pos-pwa,super-admin-web}/package.json` and `pnpm-lock.yaml`. Verified: the lockfile changes are `next`, `@next/env` and the 8 `@next/swc-*` platform packages only. **No other package changes version.**
2. It clears two advisories on every other branch: `GHSA-mfr8-8qww-v76h` and `GHSA-vc7v-qv4w-wrv8`. After #45, `osv-scanner` reports **no finding** (measured 2026-11-18 after the picomatch withdrawal; before it, exactly one: picomatch).
3. The four apps still build and the browser journeys pass (`e2e` pass on #45; the Customer Web storefront was also exercised on 16.4.6 in a separate worktree: unit 29, browser 6/6).
4. Lockfile conflict is expected when merging with #44; resolve by taking `main`'s lockfile and re-running `pnpm install --lockfile-only`, never by hand-editing.

Approval required: **independent security review** (a dependency-only change, low effort). Merge dependency: after #51. With #45 in, the `security` job can reach gitleaks and Trivy for the first time (read those results).

## #46 and the picomatch exception (superseded: not needed)

`GHSA-fc5q-39xc-vjpf` was withdrawn at 2026-11-18T15:38:56Z (OSV record modified 15:56:12Z). Before that it affected picomatch `<= 4.0.7` with no patched release, and the plan was a time-bounded `osv-scanner.toml` entry. **No exception exists in any PR and none is to be created.** Measured now with osv-scanner v2.5.1: #45's lockfile, no config, exit 0.

Reviewer checklist (independent security reviewer, on #46 and the record):

1. Read the withdrawal reason upstream. The OSV text says "withdrawn because it is a security issue", which cannot be right as written; the maintainer thread says the opposite.
2. Is picomatch reachable at runtime in any shipped service, or only in build and test tooling, as #46 assesses? The code is **not** patched; only the advisory is gone.
3. Decide whether #46 merges as a record, is closed, or is kept until the advisory settles.

Approval required: none for an exception (none is proposed). #46 is a docs record: owner decision.

## #47 — scoped gitleaks exceptions

Two allowlists attached to the single rule `generic-api-key`; each applies only when **all** its conditions hold; every other rule still scans every file.

1. `infra/migrate/approved-migrations.json` only, and only for a line shaped `<14-digit timestamp>_<snake_case>": "<64 lowercase hex>"` (a generated migration-hash manifest; the word "token" in a migration name triggers the rule).
2. `docs/decisions/**/*.patch` only, and only the public fixture password `CorrectHorseBatteryStaple9` (the hash-pinned approval patches embed it and cannot be edited).

Reviewer checklist (independent security reviewer):

1. Are the two regexes anchored and unable to match a real credential? (A 12-case negative-control matrix is posted on the PR.)
2. Is exception 2 acceptable? **Candidate patches in this repository use that exact fixture password on purpose** so they pass under it; a different password in a `.patch` is flagged.
3. Re-verified today with gitleaks v8.24.3 (git mode, so path conditions apply): the F-7b v2, F-7c and gate candidate patches are **clean** under #47's config and show exactly 1 finding (the fixture password) under today's `main` config.
4. gitleaks ran in CI for the first time on #45's re-run (2026-11-18, `main`'s config) and passed; #45 touches none of the files the two exceptions concern. The first run on a branch that carries them (the approval patches under `docs/decisions`, `infra/migrate/approved-migrations.json`) shows in CI whether #47 is really needed; expect to read that result.

Approval required: **independent security review**. Merge dependency: none technically; merge before the docs/candidate branches (#42 onward) so their `security` job can reach gitleaks.

## Merge order (every merge needs the owner; every stacked PR must take `main` in afterwards)

1. **#51** (owner decision) → 2. **#45** (security review) → 3. **#47** (security review) → 4. **#42** (docs) → 5. **#43** and **#52** (F-7a inert) → 6. **#44** → 7. **#48** → 8. **#49**. #46 (a record) at any time, owner decision. This docs PR (#53, stacked on #42) follows #42.

Each merge: take `main` into the branch, wait one CI cycle (about 25 minutes), read the result honestly. `verify` only turns green on branches that contain #51; `security` only turns green once #45 is in (osv) **and** the gitleaks and Trivy steps, which have not yet run on any branch, pass (gitleaks needs #47 for the two verified false positives).
