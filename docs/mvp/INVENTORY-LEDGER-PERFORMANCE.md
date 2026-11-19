# Inventory ledger — commit-guard performance review

2026-11-15 · UNCOMMITTED · evidence for DRAFT-I revision 2. Test: `apps/api/src/modules/stock/stock-ledger-benchmark.integration.test.ts` (real PostgreSQL, application role, FORCE RLS; the recorded run: `BENCH_SIZES=1000,10000,100000 BENCH_REPS=5`).

## 1. The problem found in revision 1

DRAFT-I revision 1 verified consistency at commit by **re-summing the variant's whole history** (Σ movements, Σ batches, a lateral join to every batch's allocations) and fired that check once per touched row (movement, balance, batch, allocation). The cost of one sale therefore grew with the variant's history **and** with the number of rows the sale touched.

## 2. Options evaluated

| Option                                                                                                           | Safety                                                                                                                                                                                                 | Commit cost                     | Verdict                                         |
| ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------- | ----------------------------------------------- |
| A. Keep the full re-sum per commit                                                                               | strongest per commit                                                                                                                                                                                   | O(history × rows touched)       | **rejected** — see the measurements             |
| B. Indexed incremental balances **maintained only by database triggers** (running totals) + constant-time guards | the application cannot write the totals (column privileges); the guard compares the app's figures with figures derived independently by the database from every inserted movement / batch / allocation | O(1) per row                    | **adopted**                                     |
| C. Defer verification to a periodic job only                                                                     | an inconsistent state could commit and live until the job runs                                                                                                                                         | O(1)                            | **rejected** as the only guard (weakens safety) |
| D. Periodic full-ledger reconciliation (`fn_stock_reconcile_key` / `_company`) **in addition** to B              | re-derives everything from the append-only history; also detects drift of the running totals themselves                                                                                                | O(history), off the commit path | **adopted alongside B**                         |

What B checks at commit, each in constant time: balance = Σ movements (running total); Σ batches = balance quantity (LOT_ACTUAL: also value; WEIGHTED_AVERAGE: batches carry no value); one batch = received − net allocations; one movement is fully allocated to batches; a receipt has its batch. **Nothing was removed from the set of invariants** — the same properties are enforced, against different (trigger-maintained) operands. Append-only history, RLS, the locked-method guard, currency / unit integrity and the reversal bounds are unchanged. Two further changes in the same revision: first-row probes go through the ordered key index (a bitmap probe was found to read the whole variant history — see §4), and the issue path reads only as many batches as it consumes (two partial indexes, geometric LIMIT).

## 3. Results (ms, median / p95 of 5 runs, one issue of 1 unit, history of N receipts ≈ 1.5 N movements)

| Method           | History N | **FAST** (adopted) issue | FAST receive | FULL re-sum guard issue (revision 1 reproduced) | FULL ÷ FAST | Full reconciliation |
| ---------------- | --------- | ------------------------ | ------------ | ----------------------------------------------- | ----------- | ------------------- |
| LOT_ACTUAL       | 1,000     | 22.3 / 26.8              | 26.8 / 31.5  | 108.2 / 111.0                                   | 4.8×        | 11 ms               |
| LOT_ACTUAL       | 10,000    | 27.5 / 31.3              | 18.3 / 19.8  | 1,002.5 / 1,045.8                               | 36.5×       | 584 ms              |
| LOT_ACTUAL       | 100,000   | **49.1 / 64.5**          | 21.3 / 22.8  | **8,875.6 / 9,118.8**                           | **180.9×**  | 1,126 ms            |
| WEIGHTED_AVERAGE | 1,000     | 25.5 / 36.5              | 21.7 / 29.8  | 413.0 / 444.7                                   | 16.2×       | 77 ms               |
| WEIGHTED_AVERAGE | 10,000    | 22.1 / 26.7              | 15.3 / 17.7  | 1,376.8 / 1,889.0                               | 62.2×       | 157 ms              |
| WEIGHTED_AVERAGE | 100,000   | **41.7 / 51.1**          | 23.6 / 25.5  | **11,506.5 / 13,971.1**                         | **276.0×**  | 1,247 ms            |

The shipped guards are flat across a 100× history growth (22 → 49 ms and 25 → 42 ms, the small rise being the batch read below); the revision-1 guard grew ~80–450× (108 ms → 8.9 s; 413 ms → 11.5 s per sale). Each timed operation includes the real service, the transaction and every deferred guard. After every timed run the history was re-verified with the full reconciliation (no violation). The bulk-loaded synthetic history was itself verified by `fn_stock_reconcile_key` before timing. Measured on a developer machine with Docker Desktop: use the ratios, not the absolute milliseconds.

## 4. Query plans (recorded in the benchmark output; excerpts at 100,000 receipts)

| Query                                                | Plan                                                                                            | Cost                   |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ---------------------- |
| idempotency lookup of a source                       | `Index Scan using stock_movement_idempotency_uq`                                                | 4 buffers, 0.04 ms     |
| balance row (commit guard)                           | one 1-page read (`Seq Scan` on a tiny table; the primary key is used once the table grows)      | 1 buffer, 0.03 ms      |
| "does the variant have a movement" (first-row probe) | `Index Only Scan using stock_movement_key_idx`, LIMIT 1                                         | 5 buffers, 0.07 ms     |
| pick non-expiring batches (FIFO), LIMIT 32           | `Index Scan using inventory_lot_pick_fifo_idx`                                                  | 35 buffers, 0.08 ms    |
| pick expiring batches (FEFO), LIMIT 32               | `Bitmap Heap Scan` over `inventory_lot_pick_expiry_idx` — **read 16,667 open expiring batches** | 1,592 buffers, 11.7 ms |
| full reconciliation Σ movements (periodic only)      | `Parallel Bitmap Heap Scan` over `stock_movement_variant_idx` (150,000 rows)                    | 92 ms                  |

**Finding (benchmark-discovered, fixed):** the first version of the first-row probe used `EXISTS … LIMIT 1` and PostgreSQL answered it with a **bitmap scan of the variant's entire history**; it now orders by the key index so the plan is an index-only scan that stops at one entry (5 buffers). **Open finding:** with 16,667 open expiring batches of ONE variant the planner chooses a bitmap scan for the FEFO read (11.7 ms) instead of an ordered index scan that would stop after 32 rows. That cost follows the number of _open expiring batches of one variant_ (a florist variant holds tens, not thousands) — not the history — and 11.7 ms is inside the 49 ms total, so it is **recorded, not gated**. If a customer ever holds thousands of open expiring batches of one variant, the mitigation is a one-line planner hint (`SET LOCAL enable_bitmapscan = off` inside the pick query's transaction) or a keyset-paged read; it needs a measured trigger, not a guess.

## 5. Operational rules this implies

- **Nightly and at period close:** run `fn_stock_reconcile_company(tenant, company)` (O(history); 1.1–1.2 s per 100,000-movement variant). A non-empty result is a build-blocking / alerting condition, exactly like the cash and receivables reconciliations; it re-derives balance, running totals, batches, allocations and receipts from the append-only history.
- The reconciliation is the **only** O(history) code, and it never runs on the commit path.
- Hot-row note: the `(branch, variant)` balance row is the intended serialisation point (rule 23). Throughput per hot item is bounded by that row's transaction time (≈ 20–50 ms here); 25 simultaneous sales of one item against 10 units were proven correct (exactly 10 sell).
