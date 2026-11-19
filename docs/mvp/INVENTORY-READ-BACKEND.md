# Inventory read backend — what exists, what was measured, what is missing

_2026-11-15 · worktree `fwt\p4` · everything uncommitted · **no migration, no route, no frontend page, no journal activation** · nothing here is an approval_

This is the evidence for the 11 inventory reads the Owner Web and POS inventory components need. The code is **real and tested against real PostgreSQL**
(`apps/api/src/modules/stock/reads/`), but **inert**: no controller, no module registration, nothing imports it outside the stock module. Activation is
the separate, approval-blocked route patch (`DRAFT-N`, S-1 review).

## 1. The reads

| #   | Read                                     | Function                                                  | Order / paging                                                                 | Permission                  |
| --- | ---------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------ | --------------------------- |
| 1   | Company + per-branch stock summary       | `stockSummary`                                            | branches by name; one statement                                                | `inventory:view`            |
| 2   | Stock on hand per item, one branch       | `listStockRows`                                           | keyset by variant id; search; optional "also not-yet-tracked catalog items"    | `inventory:view`            |
| 3   | Valuation by the company's locked method | `stockValuation`                                          | branches by name                                                               | `inventory:view`            |
| 4   | Batches / lots with expiry               | `listLots`                                                | keyset (expiry, receipt sequence); no-expiry last; empty batches hidden        | `inventory:view`            |
| 5   | Movement history                         | `listMovements`                                           | keyset (createdAt, id) newest first; type / item / date filters                | `inventory:view`            |
| 6   | Opening / receiving document history     | `listStockDocuments`, `getStockDocument`                  | keyset (createdAt, id); detail by id with lines                                | `inventory:view`            |
| 7   | Adjustments / wastage history            | `listAdjustments`, `listAdjustmentLines`, `getAdjustment` | keyset                                                                         | `inventory:view`            |
| 8   | Stock-count / variance history           | `listCounts`, `getCount`                                  | keyset; detail has expected / counted / variance and its value                 | `inventory:view`            |
| 9   | Reconciliation status (read-only)        | `reconciliationStatus`                                    | computed on demand by the existing report; no history is stored                | `inventory:view`            |
| 10  | Bouquet component availability           | `bouquetAvailability`                                     | the SAME arithmetic a sale consumes with (`bomAvailability` + `explodeRecipe`) | `inventory:view`            |
| 11  | POS sellable quantities                  | `posSellable`                                             | ≤ 200 items per call                                                           | `inventory:view` (S-5 open) |

Every read: permission checked **first** (before any query) · one **REPEATABLE READ, READ ONLY** snapshot transaction per response (a list and its aggregates can
never disagree) · tenant and company named explicitly in every statement **and** FORCE RLS as the backstop · a branch the session may not read looks exactly like
a branch that does not exist (`404 STOCK_SCOPE_NOT_FOUND`) · money = integer minor units in a string + currency + exponent (KWD/BHD/OMR = 3) · quantities =
exact 4-decimal text in the item's base unit, never summed across units · **sellable = on hand − expired batches, never negative** · cursors are opaque, strictly
validated keyset cursors (no OFFSET) · every response carries `snapshotAt`.

## 2. Corrections the verification forced (UI contracts changed in the same change)

| Was                                   | Problem                                                                  | Now                                                                           |
| ------------------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| `DashboardData.expiredUnits` (a sum)  | adds stems, metres and pieces: meaningless                               | `itemsWithExpiredStock` — a **count of items**                                |
| `ReconciliationView.totalOnHand`      | same mistake                                                             | dropped (value and balances-checked remain); `totalValue` may be `null`       |
| `ReconciliationView.checkedAt`        | the report is computed on demand from one snapshot                       | `snapshotAt`                                                                  |
| `DashboardData.lowStockItems: number` | **no low-stock threshold is persisted anywhere**: any number is invented | `number \| null`; the dashboard prints "Not configured", never 0              |
| `BouquetAvailabilityFacts.asOf` (POS) | the API sent only `snapshotAt`                                           | the API bouquet read also carries `asOf` (= `snapshotAt`), like the till read |

## 3. Missing persisted information (not invented; each is an integration dependency)

1. A per-item, per-branch **low-stock / reorder threshold** (`lowStockAt`, `lowStockItems` stay absent / `null`).
2. **User display names**: a `user` row has an e-mail only (no `staff` model yet) → `createdBy` / `approvedBy` / `requestedBy` / `countedBy` carry the e-mail.
3. **Stored reconciliation reports**: the job's output is not persisted → the report is computed on demand and has **no history**, no "last run" time.
4. A movement's **counterparty document title**: a movement carries `sourceKind` + `sourceId` only (a document / adjustment / count can be opened by id; a sale line cannot be titled).
5. **Substring search at scale** needs a trigram index on product / variant names (catalog module); the stock-row search is a scan today (see §5).
6. Inventory **permission keys** in the shipped role baseline (`inventory:view` is the proposed key; granting it is a security-review item, S-1 / S-5).

## 4. Verification

| Check                                                                                           | Result                                                                                                         |
| ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Read model against real PostgreSQL (inventory drafts on a **disposable** DB), both methods      | `inventory-reads.integration.test.ts` — **51 tests green** (25 per method incl. safety, + the page-limit rule) |
| Golden recorded from the real output + deterministic re-record                                  | `inventory-reads-ui-golden.integration.test.ts` green; identical across 3 re-recordings                        |
| Owner Web: contract shapes key-by-key + components rendering the real output                    | `api-golden.test.ts` — 19 tests; whole inventory folder 98 tests green                                         |
| POS: till facts + bouquet readout from the real output; hint is never a gate                    | `api-golden.test.ts` — 10 tests; whole inventory folder 38 tests green                                         |
| Growing-dataset benchmark (BEFORE / AFTER the read indexes, plans, N+1)                         | `inventory-reads-benchmark.integration.test.ts` green at 1 000 / 10 000 / 40 000 items                         |
| Whole stock module (all 35 files incl. the reads, the benchmark and the inventory release gate) | `vitest run src/modules/stock` — **475 passed**, 0 failed, 0 skipped                                           |
| Structural pins + release gate (`src/verification`, `*structural*`, `inventory-release-gate`)   | 1 302 passed, 9 skipped — the 9 are the pre-existing **opt-in** Checkpoint-G load files, unrelated             |
| Owner Web / POS whole apps                                                                      | 118 / 86 passed; `tsc`, ESLint, Prettier clean on every touched folder                                         |
| Mutation sweep of the read model                                                                | see §7                                                                                                         |

What the tests prove (selected): both methods' figures equal the ledger rows; expired stock is excluded from sellable and the boundary day is judged by the
civil date (sellable ON the expiry day, expired the day after; the "soon" window includes its last day); a sold-out item (only expired stock) is reported sold out; two branches never mix; paging resumes exactly (no duplicate, no gap) even when new
movements commit between pages; a read cannot write (the whole ledger hashes identical before / after, and a write inside the read transaction is refused);
a snapshot ignores a concurrent commit (and READ COMMITTED would not); the permission is checked before the database is touched; a foreign tenant gets
`404`-equivalent answers with no figure; an unconfirmed costing method gives `INVENTORY_NOT_ENABLED` and a `SKIPPED` reconciliation; a drifted balance gives a
real `DISCREPANCIES` report with findings and `consistent: false`.

## 5. Query performance (real PostgreSQL, application role under FORCE RLS, one company)

Data at the largest size: **60 000 item-branch balances, 180 000 batches, 360 000 movements** (one company, two branches). Median of 5 warm runs, whole response
(all statements of the snapshot transaction). **BEFORE** = shipped indexes only; **AFTER** = + `DRAFT-P-inventory-read-indexes.sql` (two additive indexes,
applied to the disposable DB only).

| Read (page of 50)                              | BEFORE   | AFTER        | Shape after                                               |
| ---------------------------------------------- | -------- | ------------ | --------------------------------------------------------- |
| movements, branch-wide, newest first           | 120 ms   | **16 ms**    | ordered index scan, stops at LIMIT, joins 51 rows         |
| movements, issues only                         | 113 ms   | **13 ms**    | same                                                      |
| batches, branch-wide, expiry order             | 90 ms    | **15 ms**    | ordered partial-index scan                                |
| batches expiring by a date                     | 46 ms    | **12 ms**    | same                                                      |
| stock rows page                                | 18 ms    | **15 ms**    | balance primary key is already the page order             |
| deep page (page 40 of each of the three above) | —        | **13–18 ms** | flat: keyset, not OFFSET                                  |
| documents / adjustments page                   | 19–20 ms | 18–25 ms     | small tables, no change needed                            |
| company stock summary                          | 182 ms   | 181 ms       | **linear**: one aggregate over every balance + batch      |
| valuation                                      | 68 ms    | 58 ms        | **linear**: same                                          |
| stock-row search (`ILIKE '%x%'`)               | 68 ms    | 69 ms        | **linear**: a substring scan needs a trigram index (§3.5) |

**N+1:** none. A list response is 5 statements (company facts, locked costing method, branch check, snapshot instant, the page) plus 2 planner switches = 7 at
**every** size and every page size (documents / adjustments / counts: 5, no switch); the summary is 3 statements; no statement count grows with rows or pages. User labels, product and variant names are joined in the page
statement for the ≤ 51 returned rows only.

**Three planner findings, all fixed, all measured** (plans for every statement are recorded by the benchmark with `BENCH_PLANS=<file>`):

1. **Join order.** The first shape joined catalog / user rows for _every_ row of the branch and sorted afterwards (97 ms at 15 000 items). The page is now
   selected from the ledger table alone (`WITH page AS MATERIALIZED … ORDER BY … LIMIT`), and only those ≤ 51 rows are joined.
2. **RLS makes the planner under-estimate.** Every scoped table carries the branch policy `app.branch_id IS NULL OR "branchId" = …`; PostgreSQL estimates that
   `OR` at ≈ 0.5 % of the rows (it expected 55 rows where 45 000 existed), so for a branch below ≈ 100 000 rows it chooses "bitmap scan + sort everything"
   (≈ 120 ms for the deepest page of 120 000 batches, linear in the branch). The page statements therefore run with the planner forbidden to sort
   (`indexOrdered`, transaction-local, restored right after) so the ordered index is always used. **Correctness never depends on it** — the same pages come out
   with the switch off (a test runs both and compares every page).
3. **JIT.** Forbidding the sort adds an artificial plan cost that pushes the statement over `jit_above_cost`; compiling it took **~500 ms for a 1 ms
   statement**. `jit` is switched off in the same transaction-local block. (The recorded run that missed this showed 537 ms; the fix gives 15 ms.)

**Recorded plans** (largest size; every statement of every response is in the benchmark's plan file, `BENCH_PLANS=<file>`):

```
movements, page of 50          BEFORE (no DRAFT-P index)                      AFTER (+ DRAFT-P)
  Limit -> Sort (top-N) over a parallel scan of the branch's movements      Limit -> Index Scan using stock_movement_branch_history_idx
  Buffers: shared hit=3 254 read=18 610   Execution ≈ 120 ms                actual time 0.017..0.051 rows=51   Execution ≈ 1 ms of page work
batches, page of 50            Limit -> Sort (top-N) over 120 000 batches     Limit -> Index Scan using inventory_lot_branch_expiry_idx
  Execution ≈ 90 ms                                                         actual 0.016..0.063 rows=51   whole statement 0.9 ms
```

Note the dependency this records honestly: the page statements forbid the sort, so **without the DRAFT-P indexes they are not wrong, only slower (≈ 100 ms at this
size)**; with them the page is read in index order. The indexes are therefore part of the read-route patch, not an optional extra.

The two draft indexes (`DRAFT-P`) lead with `(tenantId, companyId, branchId, …)` because the query names all three and the planner multiplies their
selectivities. They are additive and reversible (`DROP INDEX`).

**Not weakened:** every figure above is asserted correct at every size (summary value = Σ balances; valuation `consistent`; paging has no duplicate), the
isolation tests ran unchanged, and the planner switches are a performance device only.

**Limits, stated plainly.** The company summary / valuation are O(item-branch balances + batches): ≈ 3 ms per 1 000 balances, fine for the florist shape
(hundreds to a few thousand items × a handful of branches — ≈ 10–60 ms) and ~180 ms at the 60 000-balance extreme. A cached projection would remove that; it
is not needed for the MVP. The benchmark ran on a laptop container, not a staging environment: the **HG3b-SALE-LATENCY / representative-environment gate stays
OPEN** for the write path and is not claimed here.

## 6. What this does not do (so nobody reads more into it)

No route, controller or module registration; no api-client method; no Owner Web or POS page; no migration (the two indexes are a draft); no permission key was
added or granted; the frozen sale / return / cash code is untouched; nothing approved by an owner, accountant or security reviewer is assumed or ticked
(C-2, C-3, C-7, C-8, D-1, PR-1…PR-8, pilot R-1 production secrets, S-1 all remain exactly as recorded elsewhere).

## 7. Mutation sweep

**Read model (API), 24 mutants** — each edits one source file in place, runs the 51 read tests **and** the golden test on real PostgreSQL, and restores the
file (sha256 verified after every mutant).

| First sweep                                         | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Caught (18)                                         | sellable ignoring expired batches · movement page order · movement cursor inclusive · valuation always "consistent" · Weighted-Average batch showing a value · "has more" off by one · READ ONLY removed · REPEATABLE READ → READ COMMITTED · permission not checked in `listMovements` / `listLots` / `posSellable` · branch scope not enforced · sold-out threshold · tenant not set (RLS backstop off) · application role not used · no-expiry batches sorting first · stock-row cursor inclusive · untracked reported as tracked |
| **Survived (6)** — each was a real gap in the tests | document-history cursor inclusive · expiry-day boundary · "soon" window last day · page-limit cap removed · an expired batch in branch 1 leaking into branch 0's stock rows · batch tie order                                                                                                                                                                                                                                                                                                                                        |

Each survivor got a test written for exactly that gap (documents / adjustments / adjustment lines / counts / batches resumed by pages of ONE row, with four
batches tied on "no expiry"; the expiry boundary and the soon window by varying the as-of date; the page-limit rule; a second branch holding an expired batch of
a branch-0 item), and the six were **re-run: all caught**. Result: **24 / 24**.

Not mutated, on purpose: the explicit `companyId` predicates (redundant with the branch → company foreign key and the branch-ownership check, kept as
defence in depth — removing one changes no result) and `indexOrdered` (a performance device; the plan-independence test proves it cannot change a result).

**Owner Web + POS golden-driven tests, 11 mutants** (low-stock shown as 0 · "Expired units" label back · findings wording · Weighted-Average value shown ·
approver / reason dropped · "units" printed on the reconciliation card · POS hint thresholds · untracked treated as in stock · **add-to-cart blocked when sold
out**): first sweep 10 / 11 caught; the survivor (the reconciliation card could print a unit total again) got an assertion; re-run **11 / 11**.

## 8. API layer, typed client and Owner Web / POS integration (2026-11-15, still INACTIVE)

**One contract.** The wire types, limits and strict query schemas now live in `@flower/shared-types` (`inventory-reads.ts`, 45 package tests). The API's read
services, the controller, the typed client, the Owner Web adapters and the POS adapter all import them, so a drift in any one fails `tsc` (the older golden key
comparison remains as a second check).

**Controller** (`apps/api/src/modules/stock/reads/inventory-reads.controller.ts`) — 17 GET routes under `/v1/companies/:companyId/…`: company summary / valuation /
reconciliation; per branch: summary, valuation, stock, lots, movements, stock-documents (+ by id), adjustments (+ lines, + by id), counts (+ by id), bouquet availability,
till availability. **In no Nest module: no route exists** (a test boots the real application and finds none; the release gate fails if anything registers it).
Every route: `inventory:view` + the guard pipeline's company scope, branch scope and per-branch overlay; tenant from the session; company / branch only as validated
path ids (`400 INVALID_ID`, never echoed); strict query (`400 VALIDATION_FAILED`: unknown / repeated / malformed keys, `limit` 1–200, cursor ≤ 512 opaque chars, real
calendar dates, ≤ 200 distinct UUIDs for the till), nothing echoed back; `Cache-Control: no-store`; errors in the standard envelope (401 · 403 · 404 foreign =
out-of-scope = unknown · 409 `INVENTORY_NOT_ENABLED` · 422 `CURSOR_INVALID`).

Three findings from building it:

1. **No entitlement exists for basic stock.** `inventory:view` is not in `MODULE_OF_PERMISSION` (only `recipe:*` → `production_bom` is), so the pipeline cannot gate stock reads by module,
   and changing that map is a frozen-contract amendment. The bouquet read checks `recipe:view` **and** `production_bom` in the service (same codes); the rest are foundational like the catalog.
2. **A real scope defect, fixed:** the company-wide reconciliation report would have shown other branches' findings to a session restricted to several branches (single-branch sessions were
   saved by RLS). It, the company summary and the company valuation now require unrestricted branch authority (404 otherwise); a restricted user reads one branch through the branch summary / valuation.
   The additive guard decorators (`@RequireAllBranches`, `@RequireAllPermissions`) are pinned to the report controllers by an owner-approved test, so this is enforced in the service.
3. **No default role template holds any `inventory:*` or `recipe:*` key** (verified, and pinned by a test): once the routes are registered nobody could call them until the role-grant amendment.

**Client** (`@flower/api-client`): 17 typed `inventory*` methods, GET only, `asOf` required, no scope in any query; every query the client builds is round-tripped through the server's strict schemas (46 package tests).

**Owner Web** (`src/inventory/live/`, inactive: no page, no navigation, no fetch): a read **port**, wire → view **adapters** (parameter types = shared wire types, so `tsc` proves the real responses fit the components),
`loadInventoryScreen` (parallel, a failed section never blanks the others, server messages never shown), and `InventoryScreen` with per-section loading / error / empty states, dashboard, stock + value by branch,
batches + expiry, movements, receiving / adjustment / stock-count histories (three new read-only tables), bouquet and reconciliation. Everything built is `LIVE`; the sample banner appears only on FIXTURE data. 136 Owner Web tests.

**POS** (`src/inventory/live/availability-adapter.ts`): hints only — batches of ≤ 200, de-duplicated; any failure → `UNKNOWN` (never "sold out", never an exception); a hint never blocks, reserves or consumes — **the server re-validates stock inside the lock when the sale completes**. 97 POS tests.

**Evidence.** HTTP integration (test-only module, real guards, real PostgreSQL + Redis, both costing methods): 15 tests — registration, 401 / 403 / role facts, golden key parity, figures, read-only (ledger hash unchanged),
strict query contract (23 bad queries), paging of every list by 2 = full list + forged / foreign cursors, isolation (foreign tenant, other company, out-of-scope branch, overlay), empty and unconfirmed company, detail ids.
Controller mutation sweep: **11 / 11 caught** (3 survivors in the first run were closed: overlay on the company routes, session → caller mapping test). The benchmark now **asserts** the DRAFT-P indexes are used
(plans contain `stock_movement_branch_history_idx` / `inventory_lot_branch_expiry_idx` after, not before, at 12 000 items; pages 15–22 ms flat).

**Remaining performance risks (measured, not hidden):**

- _Large company summary / valuation_ are O(item-branch balances + batches): ≈ 58 ms at 12 000 balances, ≈ 180 ms at 60 000 / 180 000 batches — linear; a cached projection would remove it (not needed for the MVP's florist shape).
- _Product search_ is `ILIKE '%x%'` over names: 32 ms at 12 000 items, ≈ 68 ms at 60 000 — linear; needs a `pg_trgm` index on product / variant names (catalog module, not drafted here).
- The page statements switch the planner's sort and JIT off (a performance device; a test proves identical pages); **without DRAFT-P the same pages are ≈ 100 ms at 360 000 movements** — the indexes ship with the route patch.
- Laptop container, not staging: the representative-environment gate stays open.
