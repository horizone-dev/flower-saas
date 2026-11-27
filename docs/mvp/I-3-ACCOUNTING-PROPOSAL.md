# I-3 — inventory accounting proposal (for accountant + owner approval)

2026-11-15 · **PROPOSAL ONLY. No account is created, no journal is posted, no frozen contract is changed.** Every row needs the accountant's explicit approval. The valued ledger (I-4) already carries exactly the figures each posting needs; posting is wired only after this mapping is approved. Account seed draft: `docs/decisions/proposed-migrations/DRAFT-J-inventory-accounts.sql`.

## 1. Accounts

Existing chart (16 accounts, categories ASSET / LIABILITY / EQUITY / REVENUE / CONTRA_REVENUE / EXPENSE). COGS is an EXPENSE-category account identified by its **key** (so Gross Profit = Net Revenue − `EXPENSE.COST_OF_GOODS_SOLD`, CLAUDE.md rule 21), which avoids changing the category CHECK.

| Purpose                                   | Key                                     | Cat       | Code | Status                                                                                                                          |
| ----------------------------------------- | --------------------------------------- | --------- | ---- | ------------------------------------------------------------------------------------------------------------------------------- |
| Inventory Asset                           | `ASSET.INVENTORY`                       | ASSET     | 1400 | **new**                                                                                                                         |
| Cost of Goods Sold                        | `EXPENSE.COST_OF_GOODS_SOLD`            | EXPENSE   | 5300 | **new**                                                                                                                         |
| Goods Received Not Invoiced               | `LIABILITY.GOODS_RECEIVED_NOT_INVOICED` | LIABILITY | 2300 | **new**                                                                                                                         |
| Opening Stock Equity                      | `EQUITY.OPENING_BALANCE`                | EQUITY    | 3100 | **reused** (ADR-0019 opening / migration clearing account; alternative: a dedicated `EQUITY.OPENING_STOCK` — accountant's call) |
| Inventory Adjustments (count gain / loss) | `EXPENSE.INVENTORY_ADJUSTMENT`          | EXPENSE   | 5500 | **new**                                                                                                                         |
| Wastage                                   | `EXPENSE.STOCK_WASTAGE`                 | EXPENSE   | 5400 | **new**                                                                                                                         |

Chart 16 → 21 (22 with `EXPENSE.CASH_OVER_SHORT`, DRAFT-C). Companion changes (not made): `ACCOUNTING_REFERENCE_ACCOUNTS`, every pin that counts the chart, backfill migration (DRAFT-J), new-company provisioning. **Frozen:** the chart of accounts.

## 2. Posting rules (one balanced entry per stock movement or per sale; same transaction as the movement — rules 16, 18, 25)

Amounts are the ledger's integer minor-unit `valueDeltaMinor` in the company currency; `branchId` is a line dimension (rule 17). `sourceKind` + `sourceId` is the existing unique idempotency key of the posting engine, so a replay posts nothing twice.

| #   | Event (movement)                                      | Debit                                                 | Credit                                  | `sourceKind` / `sourceId`                                                                                                           | Amount                                                                                    |
| --- | ----------------------------------------------------- | ----------------------------------------------------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| 1   | Opening stock (`OPENING`)                             | `ASSET.INVENTORY`                                     | `EQUITY.OPENING_BALANCE`                | `STOCK_OPENING` / movement id                                                                                                       | movement value                                                                            |
| 2   | Purchase receipt (`RECEIPT`)                          | `ASSET.INVENTORY`                                     | `LIABILITY.GOODS_RECEIVED_NOT_INVOICED` | `STOCK_RECEIPT` / movement id                                                                                                       | movement value (actual cost)                                                              |
| 3   | Sale issue (`ISSUE`, once the sale hook is approved)  | `EXPENSE.COST_OF_GOODS_SOLD`                          | `ASSET.INVENTORY`                       | `STOCK_COGS_SALE` / **order id** (one entry per sale, lines aggregated, **additive beside the frozen sale entry** — never edits it) | Σ the sale's issue costs (method's cost)                                                  |
| 4   | Cancel / return (`ISSUE_REVERSAL`)                    | `ASSET.INVENTORY`                                     | `EXPENSE.COST_OF_GOODS_SOLD`            | `STOCK_COGS_REVERSAL` / reversal movement id                                                                                        | reversal value = **original cost** (partial allowed, parts sum to the issue cost exactly) |
| 5   | Wastage (I-6)                                         | `EXPENSE.STOCK_WASTAGE`                               | `ASSET.INVENTORY`                       | `STOCK_WASTAGE` / movement id                                                                                                       | issue cost at the method's cost                                                           |
| 6   | Count loss (I-6, adjustment out)                      | `EXPENSE.INVENTORY_ADJUSTMENT`                        | `ASSET.INVENTORY`                       | `STOCK_ADJUSTMENT` / movement id                                                                                                    | issue cost                                                                                |
| 7   | Count gain (I-6, adjustment in)                       | `ASSET.INVENTORY`                                     | `EXPENSE.INVENTORY_ADJUSTMENT`          | `STOCK_ADJUSTMENT` / movement id                                                                                                    | **accountant-approved unit cost** × qty (decision A-5)                                    |
| 8   | GRNI clearing by supplier bill (only if A-9 = in MVP) | `LIABILITY.GOODS_RECEIVED_NOT_INVOICED` (+ input VAT) | accounts payable / bank                 | `SUPPLIER_BILL` / bill id                                                                                                           | **NOT proposed for the MVP**: no payables account exists (decision A-9)                   |

The engines already guarantee the figures: weighted average = `value × qty / on-hand` half-up with the last unit taking the rest; lot / layer = the lots' actual cost; reversals at original cost; Σ receipts − Σ issues + Σ reversals = shelf value to the minor unit. COGS follows the **company's locked method** (never per branch or product).

## 3. Source-key linkage and consistency

- `stock_movement` gets a nullable `journalEntryId` (FK, same tenant / company) set in the same transaction; once posting is enabled a **deferred constraint** requires one entry per movement (per sale for row 3). Idempotency: the journal's own `(tenant, company, sourceKind, sourceId)` unique key.
- **Reconciliation (nightly + at period close):** `Σ GL ASSET.INVENTORY` (company, and per branch by the line dimension) = `Σ branch_stock_balance.valueMinor`; `Σ GL COGS` = Σ issue costs − Σ reversal costs; `GRNI` balance = Σ receipts not yet billed. Any difference is a build-blocking gate like the cash / receivables ones (HG-style).
- The opening-stock entry uses the posting engine's existing controlled `accountingDate` (the opening-balance mechanism of Task 3b.6); everything else posts on the movement's business date in the company accounting timezone.

## 4. Period controls

- A stock operation whose business date falls in a **closed or locked accounting period is refused** (the posting gate `findOpenForPostingDate` aborts the whole transaction — stock and GL together). Nothing is back-dated into a closed period.
- A cancel / return posts in the **current open period** at the original cost; it never reopens or edits the original period (consistent with rule 19's reversing-entry principle).
- Opening stock needs an OPEN opening / transition period at the chosen opening date (decision A-4).

## 5. Decisions required from the accountant (none assumed)

| #    | Decision                                                                                                                                                                   |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A-1  | Approve the five new accounts, their codes and names; confirm **COGS as an EXPENSE-category key** (vs a new category).                                                     |
| A-2  | Reuse `EQUITY.OPENING_BALANCE` for opening stock, or a dedicated opening-stock equity account.                                                                             |
| A-3  | **One COGS entry per sale** (aggregated) vs one per line / per movement; branch dimension on every line.                                                                   |
| A-4  | Opening date policy: which period holds opening stock; does an opening / transition period exist for every pilot company.                                                  |
| A-5  | Unit cost for **stock gains** and for **opening balances** (supplier invoice, last cost, or a count-day valuation) — the engines take any approved total.                  |
| A-6  | Landed cost: are freight / duty capitalised into the receipt cost (the ledger takes the total as given), or expensed.                                                      |
| A-7  | **Input VAT** on purchases: stays out of inventory cost; recorded when the supplier bill is entered (so the receipt posts net of VAT).                                     |
| A-8  | Expired / wasted stock: wastage account (5400) vs adjustment account (5500); is expired stock written off at cost on a fixed trigger.                                      |
| A-9  | Supplier bills / payables in the MVP? (proposal: **no** — receipt → GRNI only; GRNI stays open until a later bill / payables task; no payables account is created).        |
| A-10 | Returns that go back to stock (partial return / credit note): at **original cost**, never today's average — approve; and which cases are wastage instead of restock (C-6). |
| A-11 | Purchase price variance between receipt and bill (needs a variance account) — only relevant if A-9 = yes.                                                                  |
| A-12 | Reporting labels: "Cost of Goods Sold" and "Gross Profit" only once COGS is real (rule 21); until then "contribution".                                                     |

## 6. Approvals and frozen items touched

Owner + accountant: A-1…A-12, C-2. Owner: chart-of-accounts amendment, the posting kinds, the frozen `complete-sale` (row 3) and cancel / credit-note (row 4) integrations (I-7 / I-8 patches). Independent security review: no HTTP raw posting is introduced (postings are produced only by the stock service inside its transaction); `inventory:*` permissions. **Not posted until approved:** the I-4 service writes no journal; `journalEntryId` and the postings are added by I-5 (receipts / opening) first, then I-7 / I-8.

- See also: `I-3-POSTING-CONTRACTS.md` (exact per-event engine contracts, proven with the real Posting Engine) and `DRAFT-J` (accounts).
