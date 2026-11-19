# I-5 — expiry and batch tracking under BOTH costing methods

2026-11-15 · resolves the earlier restriction "a WEIGHTED_AVERAGE company refuses expiry dates". **That restriction was my own interim safety choice (an average company then kept no lots, so an expiry date would have been silently lost), not an approved policy.** The owner's correction stands: costing method and physical expiry are separate concerns. No approved costing or expiry _policy_ was changed — only the interim refusal was removed, in favour of the design below.

## Design

| Concern                          | Both methods                                                                                           | LOT_ACTUAL                                                         | WEIGHTED_AVERAGE                                                                                           |
| -------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| Physical batch (`inventory_lot`) | one per receipt / opening: batch reference, expiry date, received quantity, receipt date               | carries its **actual cost**; remaining value moves with each issue | carries **quantity only** (remaining value stays 0)                                                        |
| Which stock leaves on an issue   | FEFO (earliest expiry first), then FIFO (oldest receipt); expired batches never issuable               | the batch order IS the cost-layer order                            | the batch order decides the _physical_ batch only                                                          |
| What an issue costs              | —                                                                                                      | Σ the consumed batches' actual cost                                | `pooled value × quantity ÷ on hand` (half-up, last unit takes the remainder) — **never read from batches** |
| Return / cancel                  | back to the **same batches** it left (same expiry / reference)                                         | at each batch's original cost                                      | at the original issue cost (allocation cost 0; the cost is carried by the movement)                        |
| Database guarantees              | Σ batches = balance quantity; each batch = received − net allocations; allocations = movement quantity | + Σ batch value = balance value; allocation cost = movement cost   | + every batch value = 0; allocation cost = 0; the pooled position is the only valuation                    |

**No mixing of valuation algorithms:** the WEIGHTED_AVERAGE issue cost is computed by the existing weighted-average engine from the pooled position only; the batches are consulted solely for which physical stock leaves (the lot-order function is reused with every cost zeroed — `pickBatches`). Proven by the test "LOT_ACTUAL and WEIGHTED_AVERAGE pick the SAME physical batches in the same order but cost them differently" (620 vs 660 for the same flow) and by the database guards (a batch carrying value under an average company, an allocation carrying cost, a lot-valued balance — all rejected).

## Tests (both methods)

`valued-stock-ledger.integration.test.ts`: LOT_ACTUAL FEFO / expired-lot / FIFO fallback; WEIGHTED_AVERAGE expiry + batch references + FEFO pick + pooled cost 600 (vs 500 + 120 under lot costing) + a partial return to the same batch at the original cost; same-order / different-cost parity; database guard tests (the running totals are unwritable by the application role; a WEIGHTED_AVERAGE batch cannot carry value). `stock-document.integration.test.ts`: batch reference + expiry on document lines under both methods, persisted on the batch and matched at commit.

## Still open (not silently decided)

- **C-4 (owner + accountant):** may an expired batch ever be _sold_? Today: never (both methods). How is expired stock written off — wastage at the method's cost (A-8)?
- Under WEIGHTED_AVERAGE the expired batch's units stay in the pooled average until written off (they are on the shelf and on the books); the write-off is a wastage issue.
- The catalog already has per-tenant capability toggles `lot_batch` and `expiry`. The ledger accepts batch / expiry data always (a batch exists for every receipt); **requiring or forbidding it per variant is a route-level rule** (assertEnabled on the capability), to be wired when the receiving route is approved — not a ledger rule.
