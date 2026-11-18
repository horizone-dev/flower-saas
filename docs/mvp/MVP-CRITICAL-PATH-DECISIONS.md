# MVP critical path — the exact pending decisions

2026-11-15 · what is blocked on whom, in the order that unblocks the most engineering. Nothing here is approved. "Unblocks" names the work that cannot be released (or, for some, even started) without the answer.

## 1. Decisions, grouped by the question they answer

### A. Inventory accounting — **accountant** (+ owner where marked) — `I-3-ACCOUNTING-PROPOSAL.md`, `I-3-POSTING-CONTRACTS.md`

| #    | Question                                                                                                                         | Unblocks                             |
| ---- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| A-1  | approve the five accounts / codes / names; COGS as an EXPENSE-category key                                                       | the chart, every posting             |
| A-2  | opening stock against `EQUITY.OPENING_BALANCE` (reuse) or a dedicated account                                                    | opening posting                      |
| A-3  | one COGS entry per sale (aggregated) vs per line                                                                                 | I-7 COGS                             |
| A-4  | business dates earlier than today: may stock post into a past OPEN period; which period holds opening stock                      | opening / receipts                   |
| A-5  | **valuation policy for stock gains** (approved explicit cost / last receipt cost) and who approves it; opening-balance valuation | gains, counts with surplus, openings |
| A-6  | landed cost (freight, duty) capitalised or expensed                                                                              | receipts                             |
| A-7  | input VAT on purchases stays out of inventory cost                                                                               | receipts                             |
| A-8  | account per reason: wastage vs adjustment; expired stock always wastage; theft separate                                          | adjustments / wastage posting        |
| A-9  | supplier bills / payables in the MVP (proposal: no — receipt → GRNI only)                                                        | GRNI clearing                        |
| A-10 | return costing at **original** cost; which returns restock vs are wastage                                                        | I-8                                  |
| A-11 | purchase price variance (only if A-9 = yes)                                                                                      | —                                    |
| A-12 | reporting labels (COGS / Gross Profit only when real)                                                                            | reports                              |
| A-13 | (only if D-1b = B2) production: no GL entry with one inventory account; finished-item expiry; yield-loss account                 | production                           |

### B. The frozen complete-sale hook — **owner** (+ independent security review) — `I-7-SALE-INTEGRATION-DESIGN.md`

| #    | Question                                                                                                     | Unblocks                       |
| ---- | ------------------------------------------------------------------------------------------------------------ | ------------------------------ |
| C-3  | permission to amend the frozen `complete-sale` / cancel / credit-note transactions and the chart of accounts | **the whole sale integration** |
| I7-1 | which lines deduct: `STOCKED` (+ `BOM` per D-1a)                                                             | I-7                            |
| I7-2 | untracked STOCKED variant: refuse the sale (proposal) or allow                                               | I-7                            |
| I7-3 | restock vs wastage on cancellation / credit note                                                             | I-8                            |
| I7-4 | two new `409` errors on the sale route (additive contract change)                                            | I-7                            |
| I7-5 | companies without a confirmed costing method stay byte-for-byte unchanged                                    | I-7                            |

### C. Stock adjustments and counts — **owner + accountant + security** — `I-6-ADJUSTMENTS-AND-COUNTS.md`

| #   | Question                                                                                                                                                                       | Who                | Unblocks                |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------ | ----------------------- |
| S-4 | may the requester approve their own adjustment / count; second approver above what value                                                                                       | owner              | routes                  |
| S-5 | permissions: the EXISTING `inventory:adjust` / `inventory:wastage` / `inventory:count` + ONE new `inventory:approve` (+ step-up for gains, theft, large values) + S0b baseline | owner + security   | routes                  |
| S-6 | count policy: blind count, every item or sampled, post-then-approve later                                                                                                      | owner              | count route / screens   |
| C-4 | may an expired batch ever be sold; expiry write-off automatic or manual                                                                                                        | owner + accountant | expiry handling in sale |

### D. Bouquet / BOM — **owner** (+ accountant only for B2) — `D-1-BOUQUET-BOM-DECISION.md`

| #      | Question                                                      | Recommended | Unblocks                     |
| ------ | ------------------------------------------------------------- | ----------- | ---------------------------- |
| D-1a   | BOM variants consume components at the sale (build-to-order)  | yes         | recipe schema, bouquet stock |
| D-1b   | pre-made bouquets: B1 (consumed when sold) or B2 (production) | B1 now      | production scope             |
| D-1c   | custom bouquets at the till in the MVP                        | after A     | custom picker                |
| D-1d–g | rounding up, snapshot, no substitution, catalog price stays   | confirm     | recipe design                |

### E. Receiving, costing lock and stock permissions — **owner + security** — `DRAFT-H` controller, `DRAFT-K` controller

| #     | Question                                                                                                                                                                                                                                                                    | Unblocks              |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| C-1   | an ADR recording the two-method requirement, the permanent lock and "no default"                                                                                                                                                                                            | wizard, lock route    |
| C-7   | migrations DRAFT-H / I (rev 3) / K / L / J and the THREE new permissions `inventory:costing:confirm`, `inventory:opening`, `inventory:approve` (the frozen registry already has `inventory:view` / `receive` / `adjust` / `count` / `wastage` and `recipe:view` / `manage`) | **every stock route** |
| C-8   | where the Setup Wizard lives; who confirms the method (proposal: owner + step-up MFA)                                                                                                                                                                                       | wizard                |
| C-10  | stock per company or per branch switch-on                                                                                                                                                                                                                                   | rollout               |
| S-1   | independent security review: lock route, receiving, adjustments, sale hook, reversal                                                                                                                                                                                        | release               |
| O-1…3 | offline decisions (Class B offline cash sale: recommend no; paper-log fallback; POS "sales paused" state)                                                                                                                                                                   | POS offline behaviour |

### F. Pilot track (unchanged) — R-1, F-1, F-6, F-7 route A, M-1, migration manifest, new packages. See `FINAL-APPROVAL-SHEET.md`.

## 2. Suggested order (each step unblocks the next)

1. **Owner, today:** D-1a/b, C-3 + I7-1…5, S-4, C-1, C-7 (migration + permission names) — these let engineering start the sale integration, the recipe schema and the route package in parallel.
2. **Accountant, same week:** A-1…A-12 in one sitting (the proposal is written as a checklist); A-5 and A-8 are the two that block adjustments / counts / gains.
3. **Security reviewer:** S-1 begins as soon as C-7 / S-5 fix the permission surface; it runs in parallel with the build.
4. **Then (engineering):** routes + permissions (I-13), I-5b postings, I-7 / I-8 patches on a disposable copy, Owner Web, POS availability, end-to-end.

## 3. What engineering can keep building **without any of these answers** (all inert)

`sellableQuantity` + stock-based availability read (the POS availability function), the recipe tables + service as a draft (D-1a's schema is the same under every option), the I-13 route package as drafts, the reconciliation job wrapper, the Owner Web stock screens against the draft API contract, more behavioural tests and the independent-review pack. **What cannot move at all:** applying any migration, creating any route or permission, posting any journal, touching the frozen sale, activating any gain.

## 4. The five blocking decisions, stated as the exact question to answer (updated 2026-11-15)

| ID      | Who                    | The exact question                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Recommended answer                                                                                    | Engineering unblocked by a "yes"                                      |
| ------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| **C-2** | owner + **accountant** | Approve (1) the five new accounts — `ASSET.INVENTORY` 1400, `LIABILITY.GOODS_RECEIVED_NOT_INVOICED` 2300, `EXPENSE.COST_OF_GOODS_SOLD` 5300, `EXPENSE.STOCK_WASTAGE` 5400, `EXPENSE.INVENTORY_ADJUSTMENT` 5500 (opening stock reuses `EQUITY.OPENING_BALANCE`); (2) the nine posting rules in `I-3-POSTING-CONTRACTS.md` (opening, receipt, sale COGS, return, wastage, loss, gain, and the two reversals); (3) one entry per movement, GL date = business date, branch dimension, period must be OPEN | approve as drafted; answer A-1…A-12 in one sitting (A-9: no supplier bills in the MVP)                | I-5b (chart + `journalEntryId` + postings + reconcile gate)           |
| **C-3** | owner (+ security)     | Permit amending the frozen `complete-sale`, cancel and credit-note transactions and the chart so a completed sale deducts stock, posts COGS and a cancellation / credit note restocks at original cost — with D-1…D-5 of `I-7-SALE-INTEGRATION-DESIGN.md` (which lines deduct; untracked item refused; restock vs wastage; two new `409`s; unchanged for companies without a method)                                                                                                                   | approve with the I-7 design as written                                                                | I-7, I-8 (the whole sale integration)                                 |
| **D-1** | owner                  | Do BOM variants consume their components at the sale (build-to-order) in the MVP? (D-1a) Pre-made bouquets: consumed when sold (B1) or via production documents (B2)? (D-1b) Custom bouquets in the MVP? (D-1c)                                                                                                                                                                                                                                                                                        | D-1a **yes**; D-1b **B1 now**; D-1c later                                                             | recipe schema, bouquet deduction, bouquet availability, recipe editor |
| **A-5** | **accountant**         | What cost does stock that appears without a purchase (found stock, a count surplus) carry: an accountant-approved unit cost per line (`EXPLICIT_APPROVED`), the unit cost of the last receipt of the item (`LAST_RECEIPT_COST`), or another rule? Who may approve it? Also: the valuation of **opening balances**                                                                                                                                                                                      | `LAST_RECEIPT_COST` with a mandatory approver and reference; `EXPLICIT_APPROVED` for opening balances | gains, count surpluses, openings (today all fail closed)              |
| **A-8** | **accountant**         | Which account does each adjustment reason hit: `WASTAGE` / `DAMAGED` / `EXPIRED` → `STOCK_WASTAGE`? `COUNT_LOSS` / `THEFT` → `INVENTORY_ADJUSTMENT` (is theft separate)? gains → `INVENTORY_ADJUSTMENT`? Is expired stock always wastage?                                                                                                                                                                                                                                                              | as in the proposal (`journalKindForAdjustment`)                                                       | adjustment / wastage / count posting                                  |

Not blocked by any of these (done or buildable now, all inert): the ledger, documents, adjustments, counts, batches / expiry, availability read, recipe arithmetic, the bouquet simulation. **Blocked until answered:** applying any migration, any route or permission, any journal, the frozen sale, any gain, any recipe table.

## 5. Status update (2026-11-15, after the recipe / reconciliation checkpoint)

Unchanged blockers: C-2, C-3, D-1, A-5, A-8 (section 4). Packages ready for the decision-makers: `I-3-APPROVAL-PACKAGE.md` (accounts, nine postings, A-1…A-12), `I-7-APPROVAL-PACKAGE.md` (frozen sale / cancel / credit-note amendment, lock order, security scope), `D-1-BOUQUET-BOM-DECISION.md`, `STOCK-API-PERMISSIONS-DRAFT.md` (13 routes; **three** new permission keys, not the invented `stock:*` names of earlier drafts). Newly safe-and-done (inert): recipe / BOM build-to-order services, the read-only reconciliation job wrapper, route / permission drafts with a lint test. Next safe, still without any decision: an Owner Web stock screens skeleton against the draft contract is NOT safe to build as product code (routes do not exist); what remains buildable is limited to more tests, the independent-review pack and the scheduler / alert-channel design for the reconciliation job.

## 6. One-page decision sheet

The decisions above are now condensed, with recommendation, consequence, MVP effort and minimum acceptance criteria per choice and the three approver kinds kept apart, in **`OWNER-DECISION-SHEET.md`** (owner: D-1a / D-1b / D-1c / C-3 / C-7 / C-8; independent accountant: C-2 / A-5 / A-8; independent security: S-1). Nothing in it is approved. `inventory-release-gate.test.ts` (9 tests) checks that nothing unapproved is live.
