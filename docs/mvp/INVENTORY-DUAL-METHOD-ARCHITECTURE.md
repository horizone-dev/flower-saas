# Inventory MVP — dual costing-method architecture

Status: **2026-11-14 · UNCOMMITTED proposal · nothing here is owner- or accountant-approved · nothing is applied.** This document CORRECTS earlier notes (`MVP-BLOCKER-CLOSURE-2026-11-14.md` §4 and `INVENTORY-MVP-DESIGN.md`), which treated weighted average as the only method and quantity-only as a possible bridge. Both statements are withdrawn.

## 1. The approved requirement (as restated by the owner)

Every company chooses **exactly one** inventory costing method, **permanently locked after confirmation**, in the Company Setup Wizard:

1. **Lot / Layer Actual Cost** — each receipt is a layer at its actual cost; consumption is **FEFO** for expiry-tracked items, **FIFO** fallback otherwise;
2. **Perpetual Weighted Average Cost**.

All stock valuation, COGS, returns, adjustments and inventory consumption must use that one method consistently. A quantity-only accounting shortcut is **not** enabled and **not** proposed as a default; it would need explicit owner **and** accountant approval.

Repository evidence: CLAUDE.md rule 20 names perpetual weighted average only; ARCHITECTURE says "weighted-average by default" and refers to "the company's selected costing method"; ADR-0020 and ROADMAP Phase 5 defer the method. The repository records neither the two-method choice nor the lock — the owner's wording above is the authority, and it should be written into an ADR before implementation.

## 2. Review of the WAC-only foundation against the requirement

| Piece                                                                                                                                                                                  | Verdict                                                                                                                                                                          |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `weighted-average-cost.ts` (exact WAC, 8 tests)                                                                                                                                        | Correct and reusable as **method 2**. Alone it is **non-compliant**: it covers one of the two methods.                                                                           |
| `lot-layer-cost.ts` (NEW, 10 tests: FEFO, FIFO fallback, expired lots refused, reversal to the same lots at actual cost, 200-run conservation property, parity with WAC on quantities) | Closes the gap: **method 1**. Pure, exact, inert.                                                                                                                                |
| `DRAFT-G` ledger + `stock-ledger.repository.ts` (quantity-only)                                                                                                                        | Reusable only as the **quantity half** of the valued ledger. **Must not be enabled as it stands**: it has no cost, no lots, no costing method, no GL. Treat as superseded by §4. |
| Costing method column / wizard step                                                                                                                                                    | **Does not exist** (no wizard in code; no `company` column).                                                                                                                     |
| Inventory / COGS / GRNI accounts                                                                                                                                                       | **Do not exist** (frozen chart has 14 accounts, none inventory-related).                                                                                                         |

Consistency proven so far: for the same quantity flow, both engines leave the same quantity on hand and differ only in value (test: 12 sold from 10 @ 1.00 + 10 @ 1.40 → WAC 14.40, layers 12.80, both leave 8 units).

## 3. Minimum safe dual-method architecture

**One ledger, one strategy per company.** A `CostingStrategy` port with three operations — `receive`, `issue`, `reverse` — and two implementations (the two engines above). The strategy is chosen once per company and read from the locked company setting; **no code path may choose a method per call**.

**Method lock.** `company.inventory_costing_method` (`LOT_ACTUAL` | `WEIGHTED_AVERAGE`), NOT NULL **once inventory is enabled**, set only by the Setup Wizard's confirmation step; a trigger makes it immutable after confirmation (even for platform roles; correction = a documented platform procedure outside the app). The wizard requires an explicit choice (no default), shows the consequence of each, and records who confirmed and when (audit, step-up MFA).

**Schema sketch (needs migration approval; nothing applied):**

- `stock_movement` (append-only, existing draft) + `unitCostMinor`, `totalCostMinor`, `journalEntryId`, `costingMethod` (copied from the company, CHECKed equal);
- WAC: `branch_stock_balance` + `valueMinor` (CHECK ≥ 0); trigger-only writes as in the draft;
- Lot/layer: `inventory_lot` (branch, variant, `receivedAt`, `expiryDate` NULL, `quantityRemaining`, `valueRemainingMinor`, CHECKs ≥ 0) and `stock_movement_lot_allocation` (movement ↔ lot, quantity, cost) so every reversal returns to the exact lots at the exact cost; balance = Σ lots (reconciled);
- both: idempotency unique key per source, FORCE RLS tenant + branch, reversal rule (exactly one earlier issue of the same source).

**What each operation does under each method:**

| Operation                   | Lot / Layer actual                                                        | Weighted average                                                  |
| --------------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Opening balance / receive   | new lot at the receipt cost, expiry optional                              | add quantity + cost to the position                               |
| Sale / consumption          | FEFO (expiry items) then FIFO; cost = Σ lot cost; allocation rows written | cost = value × qty / quantity (half-up; last unit takes the rest) |
| Cancel / return to stock    | quantity back into the same lots at the same cost                         | quantity back at the original issue cost                          |
| Adjustment out / wastage    | same as a sale (consumes lots in order)                                   | same as a sale                                                    |
| Adjustment in (found stock) | a new lot at an **approved** unit cost                                    | added at an **approved** unit cost                                |
| Negative stock              | refused (both)                                                            | refused (both)                                                    |
| Expired lots                | not issuable for sale (policy to confirm; wastage consumes them)          | not applicable                                                    |

**GL (same accounts for both methods; only the cost figure differs):** receipt `Dr Inventory / Cr GRNI` (opening balance: `Cr` opening-balance equity); sale `Dr COGS / Cr Inventory` at the method's cost; wastage `Dr Wastage / Cr Inventory`; each posted in the **same transaction** as the movement (rules 18, 25). COGS as an additive entry beside the frozen sale entry (own source kind), so the frozen revenue/payment posting is untouched. New accounts require a chart-of-accounts migration (frozen reference).

**Sale integration** (needs approval — frozen `complete-sale`): inside the sale transaction, per tracked line → `strategy.issue` → movement + allocations + COGS entry; any refusal aborts the whole sale. Retries are safe twice (idempotency key + the movement's unique key). POS availability stays a server-validated hint (rule 24).

**Tests required before any enablement:** both strategies through the same behavioural suite (parity of quantities; conservation of value; no negative stock under 25 parallel sales; idempotent retries; reversal exactness; rollback atomicity); method-lock immutability incl. platform role; cross-tenant / cross-branch probes; GL entry balanced and equal to the ledger (nightly reconciliation job); mutation checks of the draft migration.

## 4. Decisions required (none assumed)

| #   | Decision                                                                                                         | Who                |
| --- | ---------------------------------------------------------------------------------------------------------------- | ------------------ |
| C-1 | Record the two-method requirement and the lock in an ADR; confirm "no default method"                            | owner              |
| C-2 | New accounts (Inventory, COGS, GRNI / opening-balance equity, wastage) and the receipt / COGS / wastage postings | owner + accountant |
| C-3 | Change the frozen `complete-sale` transaction (stock + COGS hook) and the chart of accounts                      | owner              |
| C-4 | Expiry policy: expired lots not sellable; how wastage of expired stock is costed                                 | owner + accountant |
| C-5 | Approved unit cost for adjustment-in and for opening balances                                                    | accountant         |
| C-6 | What a credit note / partial return does to stock (v1: full-cancel reversal only)                                | owner + accountant |
| C-7 | Migrations (ledger + valuation + lots + method column + accounts), `stock:*` permissions + S0b                   | owner              |
| C-8 | Wizard: where the costing step lives (no wizard exists in code yet) and which role confirms                      | owner              |

## 5. Estimate (estimate; after approvals; the two engines are already proven)

Schema + method lock + wizard step ≈ 4–5 days · ledger + strategies wired, receiving / adjust routes, permissions ≈ 6–8 · sale hook + COGS posting + reversal ≈ 4–5 · Owner Web stock screens (opening stock, receive, adjust, lots with expiry) ≈ 4–5 · POS stock availability ≈ 1–2 · reconciliation + full tests ≈ 4–5 → **≈ 23–30 working days**. This is **not** on the critical path of a first controlled pilot, which can run in availability-flag-only mode if the owner accepts that in writing.
