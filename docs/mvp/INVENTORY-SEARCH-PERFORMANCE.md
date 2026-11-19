# Inventory search performance & activation safety (2026-11-16)

Status: engineering evidence, **nothing approved, nothing applied, no route / permission activated, no real migration.** All measurements were taken on a
disposable PostgreSQL 17.11 container (Testcontainers) with the application role under FORCE row-level security. **Local figures are NOT production capacity.**

## 1. What was found

Stock-list search (`listStockRows`, tracked items, `?q=`) filters `product.nameEn ILIKE '%q%' OR variant.nameEn ILIKE '%q%'` over a branch's balances, ordered by
`variantId`, keyset-paged.

- `pg_trgm` 1.6 is **already installed** by the applied migration `20260906130000_catalog_core` (trusted extension — no superuser needed on PG ≥ 13). `product` already
  has GIN trigram indexes on `nameEn` / `nameAr`; `variant` has none.
- **Finding: a trigram index is unusable by the application role.** Under FORCE RLS, `ILIKE` (`texticlike`, `proleakproof = false`) is evaluated only _after_ the RLS
  policy qual, so the planner cannot push it into a GIN index scan. Measured (60,000 balances): role bypassing RLS → uses the index; application role → **never**, even
  with `enable_seqscan = off`. A `variant` trigram index would therefore be dead weight (and the existing product ones are too, for this role).
  → `DRAFT-S-variant-name-trigram-index.sql` is written but is **optional, `recommended: false`, last in the manifest**. Not needed.
- The real cost was the shape: the single statement joined the whole branch's balances before filtering and paging, so non-matching / rare terms scanned everything.

## 2. Implemented optimisation (no migration)

`searchTrackedRows` in `inventory-reads.repository.ts` — same semantics, two phases:

1. **Window**: the first `SEARCH_WINDOW = 1000` balances (by `variantId`, after the cursor) are filtered for name matches. If a full page (+ lookahead row) is found, that is
   the answer; if the window did not exhaust the branch (`more = false`) the matches found are all of them.
2. **Candidate-first** (only when phase 1 cannot decide): variants whose own name matches ∪ variants of products whose name matches, joined to the branch balances
   after the cursor, `LIMIT page+1`.

Equivalence is proven by `inventory-search.integration.test.ts` (41 tests): a brute-force oracle SQL equals the paged service for 33 terms × page sizes 1/7/50, including
case, substrings, LIKE metacharacters (`% _ \`), Arabic / Unicode, blank queries, the 64-character limit (422), other-company / foreign-tenant isolation (RLS hides a
foreign-only product), and untracked items.

## 3. Measured before / after (V = 40,000 variants → 60,000 balances, median of reps)

| term               | rows (page) | BEFORE statement | AFTER search statements | AFTER whole service call |
| ------------------ | ----------- | ---------------- | ----------------------- | ------------------------ |
| `rose`             | 50          | 19.3 ms          | 11.9 ms                 | 31.1 ms                  |
| `Red Rose Bouquet` | 50          | 270.0 ms         | 54.5 ms                 | 69.1 ms                  |
| `#6673`            | 3           | 271.3 ms         | 45.9 ms                 | 61.4 ms                  |
| `40cm`             | 50          | 13.7 ms          | 8.6 ms                  | 24.6 ms                  |
| `zzzz` (no match)  | 0           | 266.1 ms         | 50.0 ms                 | 66.6 ms                  |
| `ro`               | 50          | 18.8 ms          | 10.9 ms                 | 24.3 ms                  |

Worst case: **271 ms → 69 ms** (whole call; ≈ 4×), asserted in the benchmark test (< 0.5× when V ≥ 20,000). The whole-call figure includes ~15–20 ms of service overhead
(role switch, snapshot, projection) that the BEFORE statement figure does not — both are shown for fairness.

### EXPLAIN (ANALYZE, BUFFERS) — shared-buffer hits at the top node (`search-plans3.txt`, scratchpad)

| term                 | statement                     | shared hit                    | execution                                                   |
| -------------------- | ----------------------------- | ----------------------------- | ----------------------------------------------------------- |
| `Red Rose Bouquet`   | BEFORE                        | 265,777                       | 266.6 ms                                                    |
|                      | AFTER phase 1 (window)        | 7,031                         | 9.0 ms                                                      |
|                      | AFTER phase 2 (candidates)    | 39,970                        | 422.6 ms † (wrong settings — see the closure report)        |
| `#6673`              | BEFORE                        | 280,407                       | 267.6 ms                                                    |
|                      | AFTER phase 1 / 2             | 7,013 / 41,655                | 10.0 / 82.7 ms                                              |
| `zzzz`               | BEFORE                        | 280,380                       | 253.8 ms                                                    |
|                      | AFTER phase 1 / 2             | 7,013 / 41,625                | 10.1 / 82.7 ms                                              |
| `rose`, `ro`, `40cm` | BEFORE → AFTER (phase 1 only) | 6,163 → 6,353 · 3,090 → 3,722 | 5.8 → 10.6 · 7.0 → 9.0 · 3.1 → 5.9 ms (single-shot EXPLAIN) |

Buffer reads fall ≈ 6–7× for the expensive terms (265–280 k → ~47 k hits for both phases combined). † **Resolved** (`INVENTORY-PERFORMANCE-CLOSURE.md` §3): that EXPLAIN capture ran with `enable_sort = off`, which the service does NOT use for phase 2 — under it the planner picks a plan that is ~5× slower (p50 207 ms measured). Under the service's real settings phase 2 is p50 41 ms. For cheap terms (`rose`, `ro`, `40cm`) the
single-shot EXPLAIN shows AFTER marginally _slower_ than BEFORE (a few ms; phase-1 materialisation) while the repeated medians show it faster; both are within noise of
each other at this scale and neither matters for users.

## 4. Extension availability & deployment permissions

- `pg_trgm` is already created by an applied migration; `DRAFT-S` repeats `CREATE EXTENSION IF NOT EXISTS pg_trgm` (a no-op) — pg_trgm is a **trusted** extension, so the
  migration role needs only `CREATE` on the database, not superuser. Managed PostgreSQL services normally allow it; confirm on the target service before relying on it.
- A plain `CREATE INDEX` takes a `SHARE` lock on `variant` (blocks writes while it builds); `CONCURRENTLY` is not possible inside a migration transaction — another reason
  `DRAFT-S` stays optional.

## 5. Migration order safety

`docs/decisions/proposed-migrations/inventory-activation-manifest.json` lists **H → I → K → L → M → P → Q → R → S** with placeholder timestamps after the newest existing
migration (`20261204120000_phase_4_device_permissions`), `requires` edges and approvals. `inventory-migration-manifest.ts` (pure) + `inventory-migration-manifest.test.ts`
(12 tests) fail on: non-canonical order, non-increasing timestamps, a step stamped before an existing migration, unknown / later dependency, duplicate names, missing draft,
a draft-header `REQUIRES` the manifest does not declare, already-applied names, and — for the final migrations folder — a missing dependency, a duplicate step, or any
dependency that sorts after its dependent. The real folder is only _listed_; no applied or frozen migration is read, edited or applied. `activation-review.integration.test.ts`
additionally applies the whole order incl. DRAFT-S in a rolled-back transaction on a bare migrated database (no residue).

## 6. Startup guard (inactive)

`inventory-startup-guard.ts`: `checkInventoryPrerequisites` (pure over a query function) + `InventoryReadsStartupGuard` (`OnApplicationBootstrap`, throws
`InventoryPrerequisitesError`). It runs as the application role in a READ ONLY transaction and checks tables (11), columns, RLS enabled **and forced**, SELECT privilege,
the two DRAFT-P indexes, and registry rows `inventory:view` / `recipe:view` (plus `inventory:availability:view` when `INVENTORY_REQUIRE_TILL_KEY=1`, S-5 option A). Its
failure text is fixed and leaks no connection details. Proved on a real database prepared step by step (bare → H → I K L M → P → Q → R) and with five broken-prerequisite
cases. It is carried by the **draft** module (`inventory-reads.module.ts.txt`); no real module registers it (release-gate pin).

## 7. Staging benchmark runner

`reads/bench/` — `inventory-bench-runner.ts` (+ CLI `run-inventory-bench.ts`, loader `inventory-bench-dataset.ts`). Hard caps are **refused, not clamped**
(reps 50, warm-up 5, concurrency 10, total calls 5,000, 10 min, 60 s per call); error-budget abort; remote targets refused unless `INV_BENCH_ALLOW_REMOTE=1`; the report
contains no URLs, ids or names and starts with the disclaimer _"NOT production capacity"_. Covers company summary, stock valuation, stock rows, product search, batches by
expiry / expiring soon, movement history (page 1 / 5), concurrent reads, answer-consistency digests.

Local run (same 60,000-balance dataset, 3 reps, 0 errors): summary p50 175 ms · valuation 77 ms · stock rows p1 16 ms · search 22–67 ms · batches 64 / 46 ms ·
**movement history 125 ms per page** (the "page 5" of that run was FIVE chained calls = 547 ms; with the DRAFT-P index absent — see the closure report §2) · 4 concurrent readers 40 calls/s.

## 8. Remaining risks

- Company summary (~175 ms) and valuation (~77 ms) are linear in balances — no optimisation done; staging numbers needed.
- **Movement history**: NOT a deep-page problem. The benchmark database lacked the DRAFT-P index, so every page was a scan + sort of the branch (~156 ms at 360 k movements, any position); with the index every page is ~3 ms in the statement / ~20 ms per call. Closure report §2.
- Search floor ≈ a catalog scan for rare / no-match terms (≈ 50 ms at 60 k balances); grows linearly with catalog size beyond the window. A usable index would require a
  leakproof matching function or a pre-normalised search column (a design change needing approval) — not done.
- (Resolved) the phase-2 plan-capture discrepancy was the `enable_sort = off` setting of the capture, not the service.
- All figures are local/disposable; staging runs of the runner are required before any capacity statement.
