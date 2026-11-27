# F-6 VAT fail-closed — amendment review (UNAPPLIED, UNAPPROVED)

Date 2026-11-14. Files: `DRAFT-F6-variant-activation.patch`, `DRAFT-F6-order-line-fail-closed.patch`, `draft-f6-variant-tax-fail-closed.integration.test.ts.txt`. Both patches pass `git apply --check` against the current worktree.

## 1. Where the gap is, exactly

| Path                                                                                        | Today                                                             | With the amendment                                                                                                    |
| ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Owner Web activation                                                                        | blocked in the UI and re-checked in the server action (applied)   | unchanged                                                                                                             |
| POS checkout                                                                                | blocked at the till (applied)                                     | unchanged                                                                                                             |
| **Direct API: activate a variant with no category** (`POST /catalog/variants/:id/activate`) | **allowed**                                                       | `409 VARIANT_TAX_CATEGORY_REQUIRED`                                                                                   |
| **Direct API: create/update an order for such a variant, then `complete-sale`**             | **allowed; the line is recorded with `rateBps = null` and tax 0** | `422 ORDER_LINE_TAX_NOT_CONFIGURED` at create/update, so no unclassified order can reach complete-sale                |
| Explicit `ZERO_RATED` / `EXEMPT` / `REDUCED`                                                | resolved as a real rate row; works                                | unchanged — the refusal triggers only on `NO_CATEGORY_ASSIGNED` or `NO_RATE_FOR_CATEGORY` in a **VAT-regime** country |
| Country with no VAT regime                                                                  | tax 0                                                             | unchanged (`regime = NONE` passes)                                                                                    |

**Answer to "can a direct API request silently create a taxable sale with a missing classification?": YES, today, until the server amendment is approved and applied.** The client guards only stop the two first-party apps. A characterisation test of the current behaviour is kept with the draft test (see §4).

## 2. The 10 affected existing integration tests (measured)

Activation hunk applied temporarily and run against `catalog-variants`, `catalog-core` and `catalog-uom` (3 of the ~10 suites that activate variants). `catalog-core` passed; these fail because the fixtures activate a variant with no category:

`catalog-uom.integration.test.ts` (5): STOCKED + BOM variant activation requires a base UOM; CUSTOM does not · deactivate + reactivate preserve the frozen snapshot · a base-UOM change is blocked once a pack identifier exists · delete is blocked by a variant base / conversion / pack id · disabling multi_uom does not hide or destroy existing custom UOMs.
`catalog-variants.integration.test.ts` (5): archiving a variant frees the combination (13–15) · option selections change only while DRAFT (29–30) · the simple-product path has no Product↔Variant deadlock (34) · replayed variant activate returns the stored 200 · 32/33/34 DRAFT→ACTIVE, ACTIVE→ARCHIVED, ARCHIVED→ACTIVE each emit a tenant-global variant event.

Required fixture change (same reviewed diff): give the product or variant a category (e.g. `STANDARD`) before activating — the shared `activateVariant` helpers in each file are the single place to do it. **Not measured:** the other suites that activate variants (`catalog-attributes`, `catalog-company-pricing`, `catalog-identifiers`, plus the cash-register, device and probe suites) and **every suite that sells** (orders, sales, receivables, reporting, `load-sale-world` — the default sale world sells an unclassified variant, which is why the order-line hunk will touch many fixtures). The order-line hunk was never executed (a frozen-file edit was refused); its blast radius needs a measured run before approval.

## 3. Approved contract changes this needs (owner)

1. Catalog activation contract: a new refusal `VARIANT_TAX_CATEGORY_REQUIRED` (409).
2. Frozen sale/order contract (Phase 3B.3/3B.4 §A5): a no-rate line in a VAT country is refused instead of recorded at tax 0 (`ORDER_LINE_TAX_NOT_CONFIGURED`, 422).
3. Both documented in DECISION-LOG; DOCUMENT/LINE rounding arithmetic is untouched.
4. Existing data: variants already ACTIVE without a category stay active (the amendment gates new activation and new orders, not stored rows); a one-off report of such variants should be run before cut-over (suggested query: ACTIVE variants where `variant."taxCategoryKey" IS NULL AND product."taxCategoryKey" IS NULL`).

## 4. Proof inventory

Applied (client): POS 6 unit + browser refusal + DB "0 invoiced lines"; Owner Web 4 unit + browser disabled/enabled. Prepared (server): 6 integration tests, 6/6 green with the hunk, refusal test fails without it (mutation). Characterisation of today's server behaviour: `draft-f6-direct-api-characterisation.integration.test.ts.txt` (a direct API sale of an unclassified variant completes with tax 0).
