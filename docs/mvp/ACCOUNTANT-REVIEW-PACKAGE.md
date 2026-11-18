# Accountant review package — inventory postings (the minimum to review)

2026-11-15 · **FOR AN INDEPENDENT ACCOUNTANT · NOT APPROVED** · nothing here is posted by any product path: the five accounts are not in any real chart, no journal is wired into the sale, and every number below comes from a disposable-database test, not from a live company. The owner has **not** approved any of it. This page consolidates `I-3-APPROVAL-PACKAGE.md`, `I-3-POSTING-CONTRACTS.md` and `OWNER-DECISION-SHEET.md` Part B; it adds no new accounting decision and answers none.

## 1. What you are reviewing (one table)

Nine entry kinds, each **one balanced entry through the existing Posting Engine, in the same transaction as the stock movement**, dated by the business date, with branch as a dimension. Five new accounts; opening stock reuses `EQUITY.OPENING_BALANCE`.

| Event                                                                           | Debit                                                     | Credit                                                                | Amount comes from                                                                                 | Questions     |
| ------------------------------------------------------------------------------- | --------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------- |
| Opening stock                                                                   | 1400 Inventory                                            | 3100 Opening Balance (existing)                                       | the opening cost entered per line                                                                 | A-5           |
| Goods receipt                                                                   | 1400 Inventory                                            | 2300 Goods Received Not Invoiced                                      | the receipt cost                                                                                  | A-6, A-7, A-9 |
| Sale (one entry per sale, all lines)                                            | 5300 Cost of Goods Sold                                   | 1400 Inventory                                                        | Σ the sale's issues at the company's locked method                                                | A-3           |
| Cancellation / return (per reversed movement)                                   | 1400 Inventory                                            | 5300 Cost of Goods Sold                                               | the **original** cost of what returns                                                             | A-10          |
| Wastage (WASTAGE / DAMAGED / EXPIRED)                                           | 5400 Stock Wastage                                        | 1400 Inventory                                                        | the issue cost                                                                                    | A-8           |
| Adjustment loss (COUNT_LOSS / THEFT)                                            | 5500 Inventory Adjustments                                | 1400 Inventory                                                        | the issue cost                                                                                    | A-8           |
| Adjustment gain (COUNT_GAIN / FOUND_STOCK)                                      | 1400 Inventory                                            | 5500 Inventory Adjustments                                            | **policy cost — refused until A-5 is answered**                                                   | A-5           |
| Wastage reversal                                                                | 1400 Inventory                                            | 5400 Stock Wastage                                                    | original cost                                                                                     | —             |
| Adjustment-loss reversal                                                        | 1400 Inventory                                            | 5500 Inventory Adjustments                                            | original cost                                                                                     | —             |
| **Walk-in return** (anonymous paid sale; one entry per return, partial or full) | REVENUE.SALES (total − tax) + LIABILITY.TAX_PAYABLE (tax) | the tender account of each refund leg: cash / bank / payment clearing | the return’s credited money (the frozen credit-note formulas, final part takes the exact residue) | A-14, A-16    |

Bouquets (build-to-order) need **no extra posting**: the sale entry is the Σ of the component issues. Production of ready-made bouquets (B2) is not part of this review unless the owner chooses it (then A-13).

## 2. Worked example (real output of `stock-sale-integration.integration.test.ts`, "worked accounting example")

Receipts: 5 units at 100 on 1 June, 5 at 200 on 5 June (Dr 1400 500 / Cr 2300 500, then Dr 1400 1,000 / Cr 2300 1,000). **One sale of 7 units** on 15 June:

| Company's locked method         | Sale entry                        | Inventory after                 | Why               |
| ------------------------------- | --------------------------------- | ------------------------------- | ----------------- |
| LOT_ACTUAL (oldest batch first) | Dr 5300 **900** / Cr 1400 900     | 600 (3 units of the 200 batch)  | 5 × 100 + 2 × 200 |
| WEIGHTED_AVERAGE                | Dr 5300 **1,050** / Cr 1400 1,050 | 450 (3 units at the pooled 150) | 7 × 150           |

Cancelling that sale posts Dr 1400 / Cr 5300 for the **same** amount (900 / 1,050), after which inventory is 1,500 under both methods and Σ GL 1400 = Σ ledger value. The sale's own revenue entry is the existing frozen one and is untouched.

### Worked example — a paid return (real output of `returns/sale-return.integration.test.ts`, disposable database, NOT live)

Anonymous sale, 7 units at 2,000 + 5% VAT = **14,700** paid in cash; stock cost 900 (LOT_ACTUAL) / 1,050 (WEIGHTED_AVERAGE). **The customer returns 3 units:**

| Entry                                                     | Lines                                                                               | Amount                                                                                                  |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `pos_sale_return`                                         | Dr REVENUE.SALES 6,000 · Dr LIABILITY.TAX_PAYABLE 300 · Cr ASSET.CASH_ON_HAND 6,300 | VAT adjusted `floor(700 × 3 / 7)` = 300                                                                 |
| `STOCK_COGS_REVERSAL` (3 units back at **original** cost) | Dr ASSET.INVENTORY / Cr EXPENSE.COST_OF_GOODS_SOLD                                  | **500** LOT_ACTUAL (2 × 200 + 1 × 100, the batches they left) · **450** WEIGHTED_AVERAGE (3/7 of 1,050) |

Returning the other 4 units later credits **8,400 incl. 400 VAT** and reverses **400** / **600** — the two returns add up to the invoice (14,700; 700 VAT) and to the whole original cost (900 / 1,050) to the minor unit. If one returned unit is **not resellable**, the customer is still refunded; the unit is then written off from the batch it returned to (`STOCK_WASTAGE`, reason DAMAGED, approver recorded). Split tender: a 6,300 sale paid 4,000 cash + 2,300 card, a 2,100 return refunds the card first (Cr ASSET.PAYMENT_CLEARING 2,100); a further 4,200 return refunds the last 200 to the card and 4,000 to cash.

## 3. The questions, split by what they block

**Must be answered before the first release** (the smallest set that unblocks I-3 and I-7):

| #    | Question                                                                                                                                                                                                                             | Recommended default (the drafts are written this way)                                          |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| A-1  | Approve the five accounts, codes and names; COGS is an EXPENSE-category key (Gross Profit = Net Revenue − that key)                                                                                                                  | approve                                                                                        |
| A-3  | One COGS entry per sale (aggregated) or per line                                                                                                                                                                                     | per sale                                                                                       |
| A-4  | May stock post into a past OPEN period; which period holds opening stock                                                                                                                                                             | allow inside OPEN periods; opening stock in a dedicated open period                            |
| A-5  | **Cost of opening balances** and of stock gains: explicit approved unit cost / last receipt cost / other; who approves                                                                                                               | openings: explicit approved cost per line; gains: **stay refused (fail closed)** until decided |
| A-8  | Account per adjustment reason                                                                                                                                                                                                        | as in the table above                                                                          |
| A-10 | Returns at original cost; which returns restock vs become wastage                                                                                                                                                                    | original cost; restock only goods flagged "back on the shelf"                                  |
| A-14 | **(paid returns only)** May a walk-in return share the company `CREDIT_NOTE` gapless counter (`CN-…`)? What does a country’s e-invoicing (KSA ZATCA) need for a credit note with no customer?                                        | share the counter; KSA stays gated                                                             | a separate counter / document type                              |
| A-15 | **(paid returns only)** The non-resellable part is written off from the returned batch: LOT_ACTUAL at that batch’s cost, WEIGHTED_AVERAGE at the pooled average at write-off time (a few minor units off the reversal cost). Accept? | accept                                                                                         | write-off at the original cost for both (needs a ledger change) |
| A-16 | **(paid returns only)** A card-terminal refund books Cr ASSET.PAYMENT_CLEARING as the sale’s card tender did; revenue / tax reversal net-of-discount                                                                                 | confirm                                                                                        | a dedicated card-refund clearing account                        |

**A-14 / A-15 / A-16 block only the paid-return release, not I-3 or I-7.**

**Can wait** (the defaults are safe and nothing is built on a different answer): A-2 (opening stock against 3100 vs a dedicated account), A-6 (freight capitalised), A-7 (input VAT outside inventory cost), A-9 (no supplier bills in the MVP — receipt → GRNI only), A-11 (only if A-9 = yes), A-12 (label COGS / Gross Profit only once COGS is real). **A-13** only if B2.

## 4. What the evidence does and does not prove

**Proved on a disposable PostgreSQL with the real Posting Engine, both costing methods:** every kind above posts one balanced entry at the ledger's own value; a sale with several lines posts ONE entry; GL inventory equals the stock ledger's value per company and per branch after every scenario (sale, retry, rejected sale, cancellation, concurrent sales); a closed accounting period aborts the whole sale **including the stock deduction**; a refused or unapproved gain posts nothing; a retry posts once; reversals post at original cost and the parts of a partial reversal sum to the write-off; a nightly gate compares GL to ledger and is read-only (`stock-posting-readiness` 7, `stock-adjustment-posting-readiness` 8, `stock-reconciliation` 9, `stock-sale-integration` — see the plan §14 for counts).

**Not proved / not claimed:** that the owner or you approved anything; any live company's numbers; tax treatment of a sale (frozen, untouched); a **paid-sale return in the product** (the disposable proof above exists; customer-linked paid returns are design only — `PAID-SALE-RETURN-DESIGN.md` §4); stock gains (deliberately unposted); supplier bills; production.

## 5. What you are NOT asked

To approve a migration, a route, a permission, the sale hook or deployment (owner and security reviewer decide those — `OWNER-DECISION-SHEET.md` Parts A and C), or to choose the company's costing method (the owner and their own accountant decide it per company; the system has no default).
