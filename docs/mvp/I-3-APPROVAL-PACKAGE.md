# I-3 approval package — inventory accounts and postings (for owner + accountant)

2026-11-15 · APPROVAL-READY, NOT APPROVED · nothing in this package is applied: no chart change, no migration, no journal is posted by any product path. Evidence is in disposable-database tests only. Companions: `I-3-ACCOUNTING-PROPOSAL.md` (rationale), `I-3-POSTING-CONTRACTS.md` (per-event contracts), `DRAFT-J-inventory-accounts.sql`, `stock-journal-mapping.ts`, `stock-posting-contract.ts`.

## 1. What approval authorises (and nothing more)

| #   | Change                                                                                                                                                                                                                                                                                                     | Frozen item touched                                                                           |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| 1   | Five new system accounts in every company's chart: `ASSET.INVENTORY` 1400, `LIABILITY.GOODS_RECEIVED_NOT_INVOICED` 2300, `EXPENSE.COST_OF_GOODS_SOLD` 5300, `EXPENSE.STOCK_WASTAGE` 5400, `EXPENSE.INVENTORY_ADJUSTMENT` 5500 (opening stock reuses `EQUITY.OPENING_BALANCE` 3100). Chart 16 → 21 accounts | `ACCOUNTING_REFERENCE_ACCOUNTS`; every pin counting the chart; a backfill migration (DRAFT-J) |
| 2   | Nine posting kinds, one balanced entry per ledger movement through the existing Posting Engine, same transaction as the movement, GL date = business date, branch dimension (table below)                                                                                                                  | none (additive source kinds)                                                                  |
| 3   | `stock_movement.journalEntryId` (nullable FK) + a deferred "exactly one entry per posting-worthy movement" check, switched on only when posting is enabled                                                                                                                                                 | the stock ledger drafts (not yet applied)                                                     |
| 4   | A nightly reconciliation gate: Σ GL `ASSET.INVENTORY` = Σ `branch_stock_balance.valueMinor`, per company and branch (the inert job already implements it: `runReconciliationJob` + `journalInventoryReader`)                                                                                               | none                                                                                          |

| Kind (sourceKind)                | Debit                          | Credit                                  | sourceId           | Amount                                   |
| -------------------------------- | ------------------------------ | --------------------------------------- | ------------------ | ---------------------------------------- |
| `STOCK_OPENING`                  | `ASSET.INVENTORY`              | `EQUITY.OPENING_BALANCE`                | movement           | opening cost (A-5)                       |
| `STOCK_RECEIPT`                  | `ASSET.INVENTORY`              | `LIABILITY.GOODS_RECEIVED_NOT_INVOICED` | movement           | receipt cost (A-6, A-7)                  |
| `STOCK_COGS_SALE`                | `EXPENSE.COST_OF_GOODS_SOLD`   | `ASSET.INVENTORY`                       | **order id** (A-3) | Σ the sale's issues at the method's cost |
| `STOCK_COGS_REVERSAL`            | `ASSET.INVENTORY`              | `EXPENSE.COST_OF_GOODS_SOLD`            | reversal movement  | **original** cost (A-10)                 |
| `STOCK_WASTAGE`                  | `EXPENSE.STOCK_WASTAGE`        | `ASSET.INVENTORY`                       | movement           | issue cost (A-8)                         |
| `STOCK_ADJUSTMENT_LOSS`          | `EXPENSE.INVENTORY_ADJUSTMENT` | `ASSET.INVENTORY`                       | movement           | issue cost (A-8)                         |
| `STOCK_ADJUSTMENT_GAIN`          | `ASSET.INVENTORY`              | `EXPENSE.INVENTORY_ADJUSTMENT`          | movement           | **policy cost (A-5)**                    |
| `STOCK_WASTAGE_REVERSAL`         | `ASSET.INVENTORY`              | `EXPENSE.STOCK_WASTAGE`                 | reversal movement  | original cost                            |
| `STOCK_ADJUSTMENT_LOSS_REVERSAL` | `ASSET.INVENTORY`              | `EXPENSE.INVENTORY_ADJUSTMENT`          | reversal movement  | original cost                            |

Bouquet (BOM) sales need **no new posting**: the sale's `STOCK_COGS_SALE` is the Σ of its component issues; a build-to-stock production run would move value inside the one inventory account (no entry) — only relevant if D-1b = B2.

## 2. The twelve accounting decisions (answer in one sitting)

| #    | Question                                                                                                                | Recommended                                                                                             | If a different answer                                    |
| ---- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| A-1  | approve the five accounts / codes / names; COGS as an EXPENSE-category key (Gross Profit = Net Revenue − that key)      | approve                                                                                                 | codes / names change in DRAFT-J only                     |
| A-2  | opening stock against `EQUITY.OPENING_BALANCE` or a dedicated account                                                   | reuse (ADR-0019 clearing account)                                                                       | +1 account, mapping changes                              |
| A-3  | one COGS entry per sale (aggregated) or per line                                                                        | per sale                                                                                                | per line: more entries, same amounts                     |
| A-4  | may stock post into a past OPEN period (business date earlier than today); which period holds opening stock             | allow within OPEN periods; opening in a dedicated open period                                           | refuse backdated stock: receipts can only be dated today |
| A-5  | **cost of stock gains and of opening balances** — explicit approved unit cost / last receipt cost / other; who approves | gains: `LAST_RECEIPT_COST` with approver + reference; openings: explicit approved cost                  | gains stay refused (fail closed) until decided           |
| A-6  | landed cost (freight, duty) capitalised or expensed                                                                     | capitalise into the receipt cost                                                                        | receipt posts net; freight expensed separately           |
| A-7  | input VAT on purchases                                                                                                  | outside inventory cost                                                                                  | —                                                        |
| A-8  | account per adjustment reason                                                                                           | wastage = WASTAGE / DAMAGED / EXPIRED; adjustment loss = COUNT_LOSS / THEFT; gains = adjustment account | per-reason accounts: more accounts                       |
| A-9  | supplier bills / payables in the MVP                                                                                    | no — receipt → GRNI only                                                                                | + payables account, bill clearing, price variance (A-11) |
| A-10 | returns at original cost; which returns restock vs are wastage                                                          | original cost; restock only goods flagged "back on the shelf"                                           | —                                                        |
| A-11 | purchase price variance (only if A-9 = yes)                                                                             | n/a                                                                                                     | variance account                                         |
| A-12 | labels: "Cost of Goods Sold" / "Gross Profit" only once COGS is real; until then "contribution"                         | confirm                                                                                                 | —                                                        |

## 3. Evidence (all on disposable databases, real PostgreSQL, real Posting Engine)

`stock-posting-readiness.integration.test.ts` (7) and `stock-adjustment-posting-readiness.integration.test.ts` (8), both costing methods: one balanced entry per event on the five accounts at the ledger's own value; per-sale COGS is ONE entry for several lines; reversals post the mirrored entry at original cost and the parts of a partial reversal sum to the write-off; GL inventory = ledger value per company and per branch; a **closed period aborts the whole operation including the stock movement**; a refused stock operation and an unapproved gain post nothing; a retry posts once. `stock-reconciliation.integration.test.ts` (9): the gate finds every kind of drift, is read-only, alerts through a port and reports `NOT_CONFIGURED` where the inventory account does not exist. Mapping unit tests (8) are exhaustive over every ledger reason code. Frozen structural pins 1,230/1,230 still pass: the producer-closure pins flagged an earlier version of the inert contract (it named a method `postJournal`) — it was renamed; no pin was edited.

## 4. Risks and how they are contained

| Risk                                      | Containment                                                                                                                                  |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| inventory GL drifts from the stock ledger | same-transaction posting + commit-time ledger checks + the nightly gate (read-only; no automatic correction)                                 |
| a wrong cost on a gain inflates inventory | fail closed until A-5; the policy and its approver are recorded on every gain line                                                           |
| posting into a closed period              | the engine's period gate aborts the whole transaction (proved)                                                                               |
| chart migration on existing companies     | additive, idempotent, owner-customised names preserved (proved on a disposable database); rollback = delete the five keys while unreferenced |

## 5. Security review scope (independent reviewer)

(1) no HTTP raw-posting path is introduced — postings are produced only inside the stock transactions through the existing engine; (2) the nine source kinds' idempotency (`sourceKind` + `sourceId`) and the period gate; (3) the adjustment / gain permission surface (`STOCK-API-PERMISSIONS-DRAFT.md`) and approver attribution; (4) that the chart migration cannot touch an existing account; (5) that the reconciliation gate is read-only.

## 6. Not included (separate approvals)

The frozen complete-sale and cancellation amendments (`I-7-APPROVAL-PACKAGE.md`), supplier bills / payables, production documents, any route.
