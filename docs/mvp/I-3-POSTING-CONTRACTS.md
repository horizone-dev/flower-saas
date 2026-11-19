# I-3 — exact stock → GL integration contracts

2026-11-15 · INERT · companion to `I-3-ACCOUNTING-PROPOSAL.md` (the accounts and the accountant's questions) and `DRAFT-J-inventory-accounts.sql`. Code: `stock-journal-mapping.ts` (the rules), `stock-posting-contract.ts` (the engine input + port). Proof: `stock-posting-readiness.integration.test.ts` — 7 tests against the **real** `PostingEngineService` on a disposable database with DRAFT-J's accounts, both costing methods. **Nothing calls any of this in the product; no chart change, no journal, no route.** Activation needs the owner and the accountant (A-1 … A-12) and a separate reviewed change.

## 1. The seven rules every posting follows

1. **Only the existing Posting Engine.** `PostingEngineService.postJournal(tx, input)`; no raw journal SQL, no HTTP, no new posting primitive.
2. **Same transaction as the stock movement**, called _after_ the ledger wrote the movement (the amount is the ledger's own `valueMinor`, never a re-computed figure). Movement, batches, balance and journal entry commit together or not at all (rules 18, 25, 29). Any posting refusal — closed period, missing account, imbalance — aborts the whole transaction **including the stock movement** (proved: a CLOSED period leaves no movement, no balance row and no journal).
3. **Idempotent by source:** the engine's unique `(tenant, company, sourceKind, sourceId)`. A retried stock operation replays its ledger result (`ALREADY_APPLIED`) and the engine answers `created: false` with the original entry id — never a second entry (proved).
4. **GL date = the movement's business date** (`accountingDate`, the engine's existing explicit-date mechanism: validated civil date, the period of that date must be OPEN). This keeps GL and stock reconcilable by date. Whether a business date earlier than today may post at all is accountant decision A-4.
5. **Branch dimension** on every entry (rule 17); company currency (the engine's); one entry per event; zero value posts nothing.
6. **Lock order:** stock `(branch, variant)` balance rows are locked first, in ascending order; the engine then takes the company lock and the accounting-period share lock. No path takes a stock lock after a posting lock (see `I-7-SALE-INTEGRATION-DESIGN.md` §4).
7. **Reconciliation is part of the contract:** Σ GL `ASSET.INVENTORY` = Σ `branch_stock_balance.valueMinor` for the company, and per branch by the line dimension (proved, both methods).

## 2. Per-event contracts

`amount` is always the ledger movement's value in minor units. "Source" is the `sourceKind` / `sourceId` pair.

| #   | Event (ledger call)                                            | Entry (Dr / Cr)                                                              | Source                                       | Amount                                                    | Date             | Notes                                                                                                                                                                                                                                                                          |
| --- | -------------------------------------------------------------- | ---------------------------------------------------------------------------- | -------------------------------------------- | --------------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | **Opening balances** (`openStock`, per document line)          | `ASSET.INVENTORY` / `EQUITY.OPENING_BALANCE` (the ADR-0019 clearing account) | `STOCK_OPENING` / movement id                | line cost                                                 | the opening date | Needs an OPEN opening / transition period (A-4). Opening cost per line is the accountant-approved valuation (A-5).                                                                                                                                                             |
| 2   | **Goods receiving** (`receiveStock`, per document line)        | `ASSET.INVENTORY` / `LIABILITY.GOODS_RECEIVED_NOT_INVOICED`                  | `STOCK_RECEIPT` / movement id                | line cost (net of recoverable VAT, A-7)                   | receipt date     | GRNI stays open until a later supplier-bill task (A-9 = out of the MVP). Landed cost policy A-6.                                                                                                                                                                               |
| 3   | **Sale COGS** (`issueStock` / `issueStockLines`, per sale)     | `EXPENSE.COST_OF_GOODS_SOLD` / `ASSET.INVENTORY`                             | `STOCK_COGS_SALE` / **order id**             | Σ of the sale's issue costs (method's cost, A-3)          | sale date        | ONE entry per sale beside the frozen sale entry (never edits it). Under WEIGHTED_AVERAGE the cost is the pooled average; under LOT_ACTUAL the lots' own costs.                                                                                                                 |
| 4   | **Refund / cancellation / return to stock** (`reverseIssue`)   | `ASSET.INVENTORY` / `EXPENSE.COST_OF_GOODS_SOLD`                             | `STOCK_COGS_REVERSAL` / reversal movement id | the reversal's value = **original cost** of what returned | return date      | Partial returns allowed; parts sum to the issue cost exactly. Posted **only if the goods go back on the shelf**; goods not restocked are wastage (row 5), decision C-6 / A-10. The customer's refund money flows are the frozen 3b.8 credit-note / refund entries — untouched. |
| 5   | **Wastage** (an issue with reason WASTAGE — I-6)               | `EXPENSE.STOCK_WASTAGE` / `ASSET.INVENTORY`                                  | `STOCK_WASTAGE` / movement id                | issue cost                                                | wastage date     | Expired stock written off here (A-8). Step-up MFA + reason (I-6 permission).                                                                                                                                                                                                   |
| 6   | **Stock adjustment — loss** (an issue with reason COUNT_LOSS)  | `EXPENSE.INVENTORY_ADJUSTMENT` / `ASSET.INVENTORY`                           | `STOCK_ADJUSTMENT_LOSS` / movement id        | issue cost                                                | count date       | I-6.                                                                                                                                                                                                                                                                           |
| 7   | **Stock adjustment — gain** (a receipt with reason COUNT_GAIN) | `ASSET.INVENTORY` / `EXPENSE.INVENTORY_ADJUSTMENT`                           | `STOCK_ADJUSTMENT_GAIN` / movement id        | **accountant-approved unit cost** × quantity (A-5)        | count date       | I-6.                                                                                                                                                                                                                                                                           |

**Inventory Asset** is `ASSET.INVENTORY` in rows 1–7 (debit when stock enters or returns, credit when it leaves). **Goods Received Not Invoiced** is `LIABILITY.GOODS_RECEIVED_NOT_INVOICED`, credited only by row 2. **COGS** is `EXPENSE.COST_OF_GOODS_SOLD`, debited by row 3 and credited by row 4.

## 3. The call shape (inert today)

```ts
// inside the SAME scoped transaction as the ledger call
const r = await issueStockLines(tx, common, lines); // 1. stock first (locks, costs, writes)
await postStockJournal(engine, tx, 'STOCK_COGS_SALE', {
  // 2. then the journal, from the ledger's own figures
  tenantId,
  companyId,
  branchId,
  sourceId: orderId,
  amountMinor: r.reduce((s, x) => s + x.valueMinor, 0n),
  businessDate,
  userId,
});
// any throw above aborts the caller's transaction: stock, batches, balance and journal all roll back
```

`buildPostJournalInput(kind, fact)` returns the exact `PostJournalInput` (source key, `accountingDate`, `branchId`, balanced lines, `createdByUserId`) or `null` for a zero-value movement; `postStockJournal(port, tx, kind, fact)` forwards it to any port with `postJournal` (an adapter over the real engine satisfies it). Contract unit tests use a fake port; the integration tests use the real engine.

## 4. What is proven today vs what stays blocked

| Proven now (disposable DB, real engine)                                                                                                                          | Blocked until approval                                                                               |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| One balanced entry per event with the exact accounts; sale COGS = ONE entry for two lines; GL inventory = ledger value, per company and per branch, both methods | the five accounts in a real chart (DRAFT-J → migration + reference-data + pin amendments)            |
| Retry posts nothing twice; closed period aborts stock too; refused stock operation posts nothing                                                                 | calling the contract from any product path; `stock_movement.journalEntryId` + the 1:1 deferred check |
| Per-sale aggregation, partial-return cost, wastage entry                                                                                                         | the accountant's decisions A-1 … A-12; the frozen sale / cancel amendments (I-7, I-8)                |
