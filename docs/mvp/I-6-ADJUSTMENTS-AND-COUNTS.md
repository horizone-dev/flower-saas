# I-6 — stock adjustments, wastage and physical counts

2026-11-15 · UNCOMMITTED · INERT (no route, no module, no accounting). Code: `valued-stock-ledger.repository.ts` (`adjustStockOut`, `adjustStockIn`, `quantityAsOf`, `quoteStockOut`, `quoteStockGain`), `gain-valuation-policy.ts`, `stock-adjustment.repository.ts`, `stock-count.repository.ts`. Schema drafts: `DRAFT-I` revision 3 (two new movement types, reason + approver on the movement) and `DRAFT-L-stock-adjustments-and-counts.sql`. Applied to disposable databases only.

## 1. Reason codes and what they do

| Direction | Reason code                                 | Cost                                                                                       | Batches it may take                                                                                 |
| --------- | ------------------------------------------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| decrease  | `WASTAGE`, `DAMAGED`, `COUNT_LOSS`, `THEFT` | company method: the batch's own cost (LOT_ACTUAL) / the pooled average (WEIGHTED_AVERAGE)  | FEFO then FIFO over **all** batches — expired batches leave first; or ONE named batch (`lotId`)     |
| decrease  | `EXPIRED`                                   | same                                                                                       | **only batches already expired** at the business date; valid stock cannot be written off as expired |
| increase  | `COUNT_GAIN`, `FOUND_STOCK`                 | **only through an accountant-approved valuation policy** (see §2); the default **refuses** | creates a batch (reference, expiry) like a receipt                                                  |

A sale still cannot reach an expired batch; only a write-off can discard it. Every adjustment movement carries its reason code and the **approving user** (database `CHECK`: an adjustment without both cannot exist; no other movement may carry them), an optional note (≤ 500 characters), the requesting user (`createdByUserId`), the exact base quantity and the value the ledger put on it.

## 2. Stock gains fail closed (decision A-5 is open)

No unit cost for stock that appears without a purchase has been approved, so the ledger **never chooses one**:

- the default policy `UNAPPROVED_GAIN_POLICY` refuses (`409 GAIN_VALUATION_NOT_APPROVED`) **before any database access**; a gain inside a document refuses the whole document (a decrease on another line rolls back with it);
- once the accountant decides, the choice is a configuration, not a code change: `EXPLICIT_APPROVED` (an accountant-approved unit cost per line, integer minor units per ONE base unit) or `LAST_RECEIPT_COST` (the unit cost of the most recent receipt / opening of the same branch + variant, derived by the ledger; no earlier receipt → `409 GAIN_NO_COST_BASIS`). An "approved" policy without an approver and a reference is not approved;
- the policy used, its reference and its approver are recorded on the adjustment line (DB `CHECK`: a gain line must name how its cost was obtained);
- no code path writes a policy today — there is no company setting — so in the product a gain cannot be posted until that setting and its approval exist.

## 3. Adjustment documents (`stock_adjustment` + lines)

Several lines per document, quantity in any convertible unit (exact conversion, ratio recorded), reason per line, optional target batch, note. Immutable (append-only; lines only in the creating transaction; header = lines = ledger movements checked at commit: quantity, value, reason, approver, source key). Duplicate submission: an advisory lock on the idempotency key serialises identical submissions **before** stock moves; same key + same content replays, different content is `409`. Separation of duties: `approverMustDiffer` is a **required** input (no default) — whether an owner may approve their own adjustment is an owner decision (the tests cover both). A write-off made in error is corrected by reversing the decrease (full or partial) at its **original cost** (`reverseIssue` with `issueType: 'ADJUSTMENT_OUT'`), or by a new adjustment — history is never edited.

## 4. Physical stock count (`stock_count` + lines)

- A count records, per item: the quantity counted, the quantity the system held **at the instant of the count** (today's balance minus every movement recorded after it — exact because history is append-only), the variance and its value. A count taken at 10:00 and posted at 10:30 does **not** turn the sales between into a shortage (proved).
- Shortage → a `COUNT_LOSS` decrease at the method's cost; surplus → a `COUNT_GAIN` increase under the approved policy. A shortage larger than the stock still on hand (sold since the count) is refused — no negative stock — and nothing changes.
- The corrections are ONE adjustment document in the same transaction: count, adjustment, movements and balances commit together or not at all. The database checks at commit that every non-zero variance has exactly the adjustment line that corrects it (direction, quantity, value, reason).
- `previewStockCount` (read-only, no lock, not binding) gives the approver the exact variance and its value by the company method, or the blocked reason per line (`GAIN_VALUATION_NOT_APPROVED`, `GAIN_NO_COST_BASIS`, `INSUFFICIENT_STOCK`); the preview equals the later posting when nothing moved in between.
- Items are locked in ascending variant id before expected quantities are computed — concurrent counts and sales of the same items serialise without deadlock (proved: 4 counts + 20 sales in opposite orders).

## 5. Both costing methods

Same code path for every stock decrease (`outMovement`: a sale and an adjustment share the lock, the costing and the batch allocation); only the valuation differs: LOT_ACTUAL takes the named / FEFO-FIFO batches' actual cost; WEIGHTED_AVERAGE takes the pooled average while the batches (quantity only) decide which physical stock leaves and carry expiry / reference. A reversal returns to the same batches at the original cost under both. Tests run every scenario against both companies and finish with `fn_stock_reconcile_company` returning no violation.

## 6. Accounting readiness (nothing posts)

Proposed mapping, pending accountant decision A-8 (`stock-journal-mapping.ts`, `journalKindForAdjustment`, exhaustive over the reason codes): `WASTAGE` / `DAMAGED` / `EXPIRED` → `Dr EXPENSE.STOCK_WASTAGE / Cr ASSET.INVENTORY`; `COUNT_LOSS` / `THEFT` → `Dr EXPENSE.INVENTORY_ADJUSTMENT / Cr ASSET.INVENTORY`; any gain → `Dr ASSET.INVENTORY / Cr EXPENSE.INVENTORY_ADJUSTMENT` at the policy value; a reversed write-off → `Dr ASSET.INVENTORY / Cr` the expense it hit. One entry per ledger movement (`sourceId` = the movement id), same transaction, existing Posting Engine, GL date = business date, branch dimension. **Proved with the real engine** (`stock-adjustment-posting-readiness.integration.test.ts`, 8 tests, both methods): balanced entries on the five DRAFT-J accounts, the parts of a partial reversal sum to the write-off, GL inventory = ledger value, a closed period aborts the whole adjustment including the stock movement, an unapproved gain posts nothing, a retry posts once. The product still calls none of it.

## 7. Decisions this needs (none assumed)

| #   | Decision                                                                                                                                                                                          | Who                |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| A-5 | valuation policy for gains (explicit approved cost / last receipt cost / other) and who may approve it                                                                                            | accountant         |
| A-8 | account per reason: wastage vs adjustment; is expired stock always wastage; is theft a separate account                                                                                           | accountant         |
| S-4 | may the requester approve their own adjustment / count (separation of duties), and above what value is a second approver required                                                                 | owner              |
| S-5 | permissions: reuse the EXISTING `inventory:adjust` / `inventory:wastage` / `inventory:count` and add ONE new `inventory:approve` (+ step-up MFA for gains, theft and large values) + S0b baseline | owner + security   |
| C-4 | may an expired batch ever be sold; is expiry write-off automatic or manual                                                                                                                        | owner + accountant |
| S-6 | count policy: must every item of a branch be counted (blind count), may a count be posted by one user and approved by another later                                                               | owner              |

## 8. Verification record (2026-11-15, after the interrupted session was resumed)

- **Recovery:** the mutation sweep had already finished (`mutants4.txt` ends with `DONE`); no worker process or container was running; `pre-sweep4.sha` matched for all six mutated files (the only later difference is the legitimate, deliberate addition of the availability read to `valued-stock-ledger.repository.ts`, which is covered by its own `pre-sweep6.sha`).
- **I-6 mutation classification (27 mutants defined):** 24 caught in the sweep; 2 **inconclusive** (L3, L4 — the regexes did not match the SQL layout, so they never executed; they were not counted as caught); 1 **survived** (L6). After fixing the patterns and adding two direct tests (a stock count dated in the future; a forged count that satisfies every row `CHECK` but not the correcting adjustment line) L3, L4 and L6 are **caught**. Final: **27 caught, 0 equivalent, 0 surviving, 0 inconclusive**.
- **Final stock suite:** 22 files, **269 tests passing** (adjustments 27, counts 18, adjustment posting readiness 8, ledger 41, documents 22, sale lines 13, batch picking 8, availability 12, bouquet simulation 23, benchmark 4 and the remaining engine / unit suites); structural pins 33 files / 1,230 passing; `tsc`, ESLint, Prettier clean.
- **Evidence for the specific claims:** gains fail closed without an approved policy (adjustments + counts + unit tests; the fail-open mutants M3 / M4 are caught); wastage and expiry (M1 / M2 / M8 caught); count-instant consistency (M10 caught; the sales-after-count test); idempotency (M14 / M15 caught; 8–10 simultaneous submissions post once); rollback (documents, counts and the bouquet simulation each leave nothing); both methods (every scenario runs against a LOT_ACTUAL and a WEIGHTED_AVERAGE company and ends with `fn_stock_reconcile_company` returning nothing).
- **Not covered by evidence:** any route, permission or accounting activation (none exists); the full repository regression (not run); behaviour on a real remote database.
