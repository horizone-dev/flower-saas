# CI baseline — review checklists for PR #51, #45, #46 and #47 (2026-11-18)

**Nothing here is approved, merged or applied.** The owner has **not** authorised merging #45, #47 or #51 and has **not** authorised the picomatch exception. This file is what a reviewer needs in order to decide. Every statement below was re-checked on 2026-11-18 against the PR heads named in the table.

| PR  | Head      | Change                                                      | `verify`                              | `security`                             | `e2e` / `realtime` | Reviews |
| --- | --------- | ----------------------------------------------------------- | ------------------------------------- | -------------------------------------- | ------------------ | ------- |
| #51 | `827e797` | 1 line: API test stack PostgreSQL `17` → `17.11`            | **pass**                              | fail (osv: 2 Next + picomatch)         | pass / pass        | 0       |
| #45 | `7abcdad` | `next` 16.4.1 → 16.4.6 in 4 apps + lockfile                 | fail (only the PG 17.12 report files) | fail (osv: **picomatch only**)         | pass / pass        | 0       |
| #46 | `e7a2352` | 1 docs file: picomatch risk assessment + exception proposal | fail (same)                           | fail (osv)                             | pass / pass        | 0       |
| #47 | `7edf2ff` | `.gitleaks.toml` +27 lines, two scoped exceptions           | fail (same)                           | fail (osv; gitleaks/Trivy **skipped**) | pass / pass        | 0       |

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
2. It clears two advisories on every other branch: `GHSA-mfr8-8qww-v76h` and `GHSA-vc7v-qv4w-wrv8`. After #45, `osv-scanner` reports **exactly one** finding: picomatch (`GHSA-fc5q-39xc-vjpf`, no patched version).
3. The four apps still build and the browser journeys pass (`e2e` pass on #45; the Customer Web storefront was also exercised on 16.4.6 in a separate worktree: unit 29, browser 6/6).
4. Lockfile conflict is expected when merging with #44; resolve by taking `main`'s lockfile and re-running `pnpm install --lockfile-only`, never by hand-editing.

Approval required: **independent security review** (a dependency-only change, low effort). Merge dependency: after #51; before the picomatch exception PR.

## #46 and the picomatch exception (not created, not approved)

`GHSA-fc5q-39xc-vjpf` affects picomatch `<= 4.0.7`; 4.0.7 is the latest release; **there is no patched version**. Local proof with osv-scanner v2.5.1: with #45's lockfile, no config → exit 1 (picomatch only); with the proposed entry beside the lockfile → exit 0; the same entry on `main`'s lockfile → exit 1 (the two Next advisories are still reported, so the exception masks only picomatch).

Proposed exception (**does not exist in any PR**): a new `osv-scanner.toml` next to `pnpm-lock.yaml` with one `[[IgnoredVulns]]` entry for that ID, `ignoreUntil = 2026-12-31`, and the reason text from #46. CI needs no workflow change (the file is auto-discovered with the CI-shaped command).

Reviewer checklist (independent security reviewer):

1. #46's assessment: is picomatch reachable at runtime in any shipped service, or only in build/test tooling? Is the vulnerable function used on attacker-controlled input?
2. The exception is time-bounded and names one ID only.
3. A removal task exists for the date (the entry expires by itself; CI then fails again, which is the intended reminder).
4. No generic `ignore` or severity threshold change.

Approval required: **independent security approval before the exception PR is created.** Merge dependency: #46 before or with the exception PR; both after #45.

## #47 — scoped gitleaks exceptions

Two allowlists attached to the single rule `generic-api-key`; each applies only when **all** its conditions hold; every other rule still scans every file.

1. `infra/migrate/approved-migrations.json` only, and only for a line shaped `<14-digit timestamp>_<snake_case>": "<64 lowercase hex>"` (a generated migration-hash manifest; the word "token" in a migration name triggers the rule).
2. `docs/decisions/**/*.patch` only, and only the public fixture password `CorrectHorseBatteryStaple9` (the hash-pinned approval patches embed it and cannot be edited).

Reviewer checklist (independent security reviewer):

1. Are the two regexes anchored and unable to match a real credential? (A 12-case negative-control matrix is posted on the PR.)
2. Is exception 2 acceptable? **Candidate patches in this repository use that exact fixture password on purpose** so they pass under it; a different password in a `.patch` is flagged.
3. Re-verified today with gitleaks v8.24.3 (git mode, so path conditions apply): the F-7b v2, F-7c and gate candidate patches are **clean** under #47's config and show exactly 1 finding (the fixture password) under today's `main` config.
4. gitleaks has **never run in CI** on any of these PRs (the `security` job stops at osv-scanner, so gitleaks and Trivy are skipped). The first real run happens after the picomatch gate is resolved: expect to re-check.

Approval required: **independent security review**. Merge dependency: none technically; merge before the docs/candidate branches (#42 onward) so their `security` job can reach gitleaks.

## Merge order (every merge needs the owner; every stacked PR must take `main` in afterwards)

1. **#51** (owner decision) → 2. **#45** (security review) → 3. **#46 + picomatch exception PR** (independent security approval; the exception PR is created only after it) → 4. **#47** (security review) → 5. **#42** (docs) → 6. **#43** and **#52** (F-7a inert) → 7. **#44** → 8. **#48** → 9. **#49**. This docs PR (stacked on #42) follows #42.

Each merge: take `main` into the branch, wait one CI cycle (about 25 minutes), read the result honestly. `verify` only turns green on branches that contain #51; `security` only turns green once #45 **and** the exception are in.
