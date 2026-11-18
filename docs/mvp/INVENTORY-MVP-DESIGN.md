# Inventory MVP — findings, smallest safe subset, dependencies

Status: **2026-11-14 · working notes, UNCOMMITTED · nothing here is owner- or accountant-approved.**
Code that exists: a DRAFT migration + a draft repository, both **NOT applied and NOT wired** (see §4).

> **SUPERSEDED IN PART (2026-11-14, later).** The approved requirement is TWO company-level costing methods — Lot/Layer Actual Cost (FEFO, FIFO fallback) and Perpetual Weighted Average — exactly one per company, permanently locked at the Setup Wizard. The quantity-only subset in this document (and DRAFT-G) is **not** to be enabled as a shortcut; it survives only as the quantity half of the valued ledger. See `INVENTORY-DUAL-METHOD-ARCHITECTURE.md`.

## 1. What exists today (verified in the repo)

| Area       | Finding                                                                                                                                                                                                                                                     |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Schema     | **No inventory tables at all** — no stock balance, no movement ledger, no item/lot, no reservation, no count. The only stock-like signal is `branch_variant_availability` (a boolean per branch + variant).                                                 |
| Costing    | The costing method is **not chosen in code**. CLAUDE.md rule 20 says perpetual weighted-average; ARCHITECTURE and ADR-0020 explicitly defer "the inventory costing method" to Phase 5. There is no per-company "locked costing method" field to honour yet. |
| Accounting | The chart of accounts has **no inventory, COGS, GRNI or wastage accounts** (only cash, bank, clearing, receivables, sales revenue, cancellation charge, tax payable…). ROADMAP: "COGS/inventory-value postings are stubbed until Phase 5".                  |
| Sale path  | `complete-sale` (Phase 3B, frozen) deducts nothing. No hook point exists without changing the frozen transaction.                                                                                                                                           |
| Phase 5    | ROADMAP Phase 5 = full inventory (items, partitioned movement ledger, balances, reservations, counts, receiving, wastage, COGS to GL). Large.                                                                                                               |

CLAUDE.md rules that bind any stock work: 22 (append-only movement ledger, balance derived), 23 (lock the `(branch, item)` balance, re-check inside the lock, `Idempotency-Key`), 24 (cart never consumes stock; one `AvailabilityService`), 25 (**every stock movement writes its journal entry in the same transaction**), 20 (perpetual weighted-average COGS).

## 2. The smallest subset that gives a flower shop real stock control

A **quantity-only branch ledger**: per `(branch, variant)` an opening quantity, receipts, adjustments (with a mandatory reason), and one atomic deduction per sold order line, with reversal on a full cancel. **No cost, no value, no COGS, no journal.**

What it gives the pilot: accurate on-hand quantity per branch and variant; a sale that cannot oversell (the sale is refused with `INSUFFICIENT_STOCK` instead); retries that never deduct twice; cancel puts the stock back exactly once; tenant and branch isolation by RLS; ledger = balance, provable.

What it deliberately does NOT give: stock valuation, COGS or gross profit, supplier receiving documents / purchases / payables, lots and expiry, reservations, stock counts, wastage categories, BOM / bouquet component consumption, partial returns, barcode receiving, reorder rules.

## 3. Decisions required BEFORE any of it can run (none assumed approved)

| #         | Decision                                                                                                                                                             | Why                                                                                                                                               |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| **INV-1** | Accept a **quantity-only interim with NO inventory/COGS journal** for the pilot, or wait for Phase 5.                                                                | It deviates from rules 20 and 25. Needs the owner **and the accountant**. Without COGS the system must not show "profit"; reports stay "revenue". |
| **INV-2** | **No negative stock** (the draft enforces `quantityOnHand >= 0` in the database).                                                                                    | Safe default; "allow negative" is a different constraint and changes oversell behaviour.                                                          |
| **INV-3** | Approve changing the frozen `complete-sale` transaction to call the stock ledger (one deduction per tracked line, same transaction, failure aborts the whole sale).  | Frozen Phase 3B contract.                                                                                                                         |
| **INV-4** | Which variants are tracked: the draft makes tracking **opt-in** (a variant is tracked iff it has an opening-stock movement; others keep the availability flag only). | Avoids forcing every product to carry stock on day one.                                                                                           |
| **INV-5** | New permissions (e.g. `stock:view`, `stock:manage`) + S0b baseline facts + a permissions migration; step-up for adjustments (money-adjacent).                        | Rule 13 / S0b.                                                                                                                                    |
| **INV-6** | Apply the migration (real name/timestamp, Prisma models).                                                                                                            | "No unauthorised migrations".                                                                                                                     |

## 4. What was built now (independently safe, inert)

- `docs/decisions/proposed-migrations/DRAFT-G-branch-stock-quantity-ledger.sql` — NOT in `packages/db/prisma/migrations`.
  - `stock_movement`: append-only (trigger blocks UPDATE/DELETE for every role); sign is a function of the type; adjustments require a reason; idempotency by `UNIQUE (tenant, branch, variant, type, sourceKind, sourceId)`; FORCE RLS tenant + branch.
  - `branch_stock_balance`: a projection written **only** by the AFTER INSERT trigger (the application role has SELECT only — explicit `REVOKE`, because default privileges would otherwise grant DML); `CHECK (quantityOnHand >= 0)`; the trigger's UPDATE takes the balance row lock and the CHECK is evaluated against the locked value (re-check inside the lock, no application race).
  - `SALE_REVERSAL` must match exactly one earlier `SALE` of the same source and quantity.
- `apps/api/src/modules/stock/stock-ledger.repository.ts` — `applyStockMovement` (idempotent insert, error mapping to `INSUFFICIENT_STOCK` 409 / `STOCK_NOT_TRACKED` / `STOCK_REVERSAL_WITHOUT_SALE`), `trackedVariantIds`, and `baseQuantity` (exact `qty × num ÷ den` at 4 decimals — refuses, never rounds). **Not imported by any module, no route.**
- `stock-ledger.integration.test.ts` — real PostgreSQL (the draft is applied to a disposable database only), as `flower_app` through `runScoped`:
  12/12 tests incl. **25 parallel sales of 1 against 10 → exactly 10 succeed / 15 refused / stock 0**, **20 parallel retries of one sale → deducted once**, rollback atomicity, reversal once, append-only, direct writes refused, ledger = balance, tenant + branch isolation.
  Mutation check of the draft: 5/5 mutants caught (drop the CHECK, drop the idempotency index, drop the REVOKE, drop the reversal rule, drop RLS).

## 5. Integration design (NOT built — needs INV-3)

1. Inside the sale's own transaction (after payments, before commit), for each order line whose variant is tracked in the branch: `baseQuantity(line.quantity, conversionNumerator, conversionDenominator)` → `SALE` movement, source `ORDER_LINE` + line id. A refusal aborts the whole sale (nothing is paid, nothing is deducted), and the cashier sees `INSUFFICIENT_STOCK`.
2. Retries are safe twice over: the `complete-sale` idempotency key AND the movement's own unique key.
3. A full cancel / credit of an invoice writes `SALE_REVERSAL` per line in the same transaction as the cancel. **Partial returns need a separate, approved design** (the draft allows one reversal per line).
4. POS availability: a read route for balances (`stock:view`) joined into the effective catalog → "n left / out of stock" tiles. This is a **UX hint only**; the server's `409` at `complete-sale` is the authority (rule 24: the cart never reserves).
5. Owner Web: opening stock, receive, adjust (with reason), balances per branch. The current Owner Web "Branch stock" screen shows the availability flag only and says so on screen.

## 6. Estimate (engineering days after the decisions; estimate)

Wiring + routes + permissions migration + tests ≈ 4–6 · sale-path integration with concurrency/retry/rollback tests ≈ 3–4 · Owner Web stock screens ≈ 3 · POS stock-based availability ≈ 1–2 → **≈ 11–15 working days** for the quantity-only subset. A valued engine (costing, GL, receiving, counts — Phase 5) is a multi-week effort and is **not** included.
