# Dependency security assessment — Next.js and picomatch (2026-11-18)

**Status: ASSESSMENT ONLY. NOTHING IS APPLIED TO THE MAIN DEVELOPMENT WORKTREE.** No merge, cherry-pick, commit, push or deployment was made. The experiment lives in its own Git worktree; applying it needs the owner's approval.

- Experiment: worktree `C:\Users\EXPERT\fwt\sec-assess`, branch `security/assess-next-16.4.6-2026-11` (from `origin/main` `ea56cff`). It is separate from the existing security worktrees (`flower-sec`, `fwt\m`), which were not touched.
- To discard: `git worktree remove --force C:\Users\EXPERT\fwt\sec-assess` then `git branch -D security/assess-next-16.4.6-2026-11`.

## 1. Findings (`pnpm audit`, current tree)

| Severity | Package     | Installed | Advisory                                                                                                                                               | Fixed in                                                                | Path                                                   |
| -------- | ----------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- | ------------------------------------------------------ |
| moderate | `next`      | 16.4.1    | GHSA-mfr8-8qww-v76h — cached data can leak across **root params** when a `'use cache'` function is called both directly and through `unstable_cache()` | **16.4.5** (16.4.6 is the latest stable)                                | the four web apps                                      |
| moderate | `next`      | 16.4.1    | GHSA-vc7v-qv4w-wrv8 — cache leak across root-param values in **nested `'use cache'`** functions (Cache Components)                                     | **16.4.5**                                                              | the four web apps                                      |
| high     | `picomatch` | 4.0.7     | GHSA-fc5q-39xc-vjpf — ReDoS through single-branch repeated extglobs (`+(*)`, `+(*a)`)                                                                  | **no fixed release exists** (npm's newest is 4.0.7, the vulnerable one) | `apps/api` → `vitest` → `picomatch` (dev tooling only) |

## 2. Reachability in this codebase

- **Next.js:** both advisories need `'use cache'`, `unstable_cache`, `next/root-params` or Cache Components. A search of every app (`src` and `next.config.ts`) finds **none**: exposure is **latent**, not reachable today. The customer-web storefront uses no cache APIs either. The fix is still worth taking before any of those features is adopted.
- **picomatch:** reachable only through the Vitest test runner's file globbing, with patterns from the repository's own config, never from user input; it is a development dependency and is not in any shipped runtime image.

## 3. The experiment (separate worktree)

Change made **only** in the separate worktree: `"next": "16.4.1"` → `"16.4.6"` in the four web apps' `package.json` (the same pin style the earlier `14927f8` next/sharp fix used) and a regenerated lockfile. `pnpm install --no-frozen-lockfile --ignore-scripts`: 767 packages resolved, only `next` and its native sub-packages moved.

| Check                                                                                               | Result                                                                           |
| --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `pnpm audit` after the bump                                                                         | **both `next` advisories gone**; 1 finding left (picomatch, no fix)              |
| Committed `main` + Next 16.4.6: typecheck, `next build`, unit tests of all four apps                | **all pass** (customer-web, owner-web, pos-pwa, super-admin-web)                 |
| `next build` security-upgrade notice                                                                | **0 occurrences** on 16.4.6 (on 16.4.1 it intermittently aborts the first build) |
| Uncommitted app code overlaid in the separate worktree, Customer Web storefront browser journeys    | **6/6 pass** on Next 16.4.6                                                      |
| Owner Web + cashier credit journeys (`E2E_FOCUS=owner`) on Next 16.4.6, uncommitted code overlaid   | **8/8 pass**, 14/14 database checks                                              |
| POS regression (`E2E_FOCUS=pos`: pilot, VAT guard, credit/advance, customer account) on Next 16.4.6 | **13/13 pass**, same 147 database ticks as the 16.4.1 baseline                   |

## 4. Recommendation (owner decision)

1. **Next.js:** approve a small PR that pins `next` to **16.4.6** in the four web apps and updates `pnpm-lock.yaml` (manifest + lockfile only, no source). It clears both advisories, removes the flaky build abort, and was build/typecheck/unit-test clean on committed `main` and storefront-journey clean with the uncommitted code overlaid. Re-run the full browser rehearsal on the PR branch before merging.
2. **picomatch:** **no patched version exists**, so there is nothing to apply. Accept with a documented rationale (dev-only, repo-controlled patterns, not in runtime images) and **re-check weekly**; when 4.0.8+ ships, add a pnpm override (`"picomatch@<4.0.8": ">=4.0.8"`) like the existing `glob` / `minimatch` ones. Do not downgrade across a major to dodge it.
3. Because the main worktree carries **uncommitted** app work, apply the bump in the PR for the web apps (PR 1 in `PR-BOUNDARY-PLAN.md`) or as its own dependency PR _after_ the owner approves; do not hand-edit lockfiles in the dirty worktree.

## 5. What the experiment did NOT cover (be honest before approving)

- The full 11-test rehearsal with every Owner Web spec together (catalog, MFA enrolment) was **not** re-run on 16.4.6, only the lean owner and POS modes above.
- Only a Chromium run; no staging, no production-mode proxy, no CDN. Next 16.4.6's changelog was not reviewed line by line — the evidence is behavioural (build, typecheck, unit, browser).
- The experiment ran in a worktree whose overlaid app code is uncommitted work; the manifest change itself is four one-line edits plus the lockfile.
- A first run in the separate worktree failed for setup reasons only (workspace packages and the API were not built there); those are environment gaps, not Next.js findings.
- During the run the system reaped a background shell for low memory; the orchestrator process survived and completed. No test was weakened or skipped.
