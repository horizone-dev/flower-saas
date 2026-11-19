# DECISION PACKAGE — E-5: integrating cash sales and cash refunds with register sessions

- **Status:** **FOR APPROVAL. Production wiring is NOT done and NOT claimed.** Prepared 2026-11-14 from the verified Phase 4 working tree (uncommitted, `fwt\p4`).
- **Related:** [DECISION-SHEET-cash-register-owner-accountant.md](DECISION-SHEET-cash-register-owner-accountant.md) (E-5 = decision E-5 there), [PROPOSAL-cash-register-open-decisions.md](PROPOSAL-cash-register-open-decisions.md), [E5-cash-sales-wiring.patch](E5-cash-sales-wiring.patch), ADR-0021, ADR-0022, CLAUDE.md rules 16, 18, 25, 29, 31.

## 1. What exists today (built, tested, inert)

| Component                                    | State                                                                                                                |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `cash-source-mapping.ts` (pure)              | built; which source rows are drawer cash, and the movement for each                                                  |
| `cash-movement-recorder.repository.ts`       | built; writes ONE movement per source event inside a **caller's** transaction; **called by no production code**      |
| `cash-source-reconciliation(.repository).ts` | built; **read-only** (`transaction_read_only`) session and branch-window reconciliation against `payment` / `refund` |
| `E5-cash-sales-wiring.patch`                 | prepared, `git apply --check` clean, typechecks, **not applied** — amends frozen files (§6)                          |

## 2. Source events and movement types (proposal)

| Source row (the only truth)                                         | Eligible when                                          | Movement           | Sign | Source identity        |
| ------------------------------------------------------------------- | ------------------------------------------------------ | ------------------ | ---- | ---------------------- |
| `payment` collected as a **sale tender** (walk-in or customer sale) | `method = CASH`, its attempt is `CAPTURED`, amount > 0 | `CASH_SALE`        | +    | `PAYMENT` / payment id |
| `payment` on an **existing invoice**, or a **customer receipt**     | same                                                   | `CUSTOMER_PAYMENT` | +    | `PAYMENT` / payment id |
| `refund` (local)                                                    | `method = CASH`, amount > 0                            | `CASH_REFUND`      | −    | `REFUND` / refund id   |

Never a movement: card, bank transfer, gateway, other-manual tenders; a manual-card or bank refund; a failed or pending attempt (no `payment` row exists); an unknown method. The card half of a split tender never reaches the drawer. There is **no change-giving** in the frozen model (tenders must equal the amount), so no change movement exists.

## 3. Mechanism — outbox, trigger or direct integration?

| Option                                                                                      | Verdict                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Direct transactional integration** (recorder in the same transaction as the source write) | **Recommended — and required by CLAUDE.md rule 29**, which lists "cash movement" among the effects that commit **together** with stock, GL and order state. The only option that can **refuse** a sale for a closed drawer and that gives "all or nothing". |
| Transactional outbox consumer                                                               | Not suitable as the primary path: asynchronous and at-least-once, cannot refuse, and the bounded event payload carries no terminal. Acceptable only as a repair / alerting path.                                                                            |
| Database trigger on `payment` / `refund`                                                    | Not suitable: needs a migration, and the database has no verified terminal (a `payment` has none; the terminal exists only in the session context).                                                                                                         |
| Reconciliation job (read-only)                                                              | Built. A **safety net** under any of the above, never the mechanism.                                                                                                                                                                                        |

## 4. Transaction and locking strategy (proven by 32 integration tests on the real sale world)

1. The recorder runs **after** the frozen primitives, in the same scoped transaction. Lock order stays the frozen ORDER → INVOICE hierarchy, then: per-source advisory lock → `pos_device` read → `cash_register` read → `register_session … FOR SHARE`. No new lock is taken before the frozen locks, so no inversion is possible.
2. A close takes the session `FOR UPDATE` first (already built). A sale **in flight** makes the close wait, then reconcile **including** the sale; a close that commits first makes the sale's recorder answer `NO_OPEN_SESSION`.
3. One movement per source event: unique key `(tenant, sourceKind, sourceId, type)` + `ON CONFLICT DO NOTHING`, and a type-agnostic existence check under the per-source lock (the database key includes the type, so a type-changing twin would otherwise pass).
4. The amount, method, company, branch and currency are read from the **source row by id** — the caller supplies only tenant, verified terminal, verified device and actor.
5. The device must be `ACTIVE` for the verified terminal at that moment (block / revoke / replacement stop cash immediately).
6. Only an `OPEN` session takes cash (what may be recorded while `COUNTING` is open decision S-2).

## 5. Late-event policy (proposal)

With the direct integration there are **no late events**: the movement commits with the source or neither does. Guards for anything that arrives otherwise (a repair run, a historical backfill): a source row **created before the session opened** is refused (`SOURCE_PREDATES_SESSION`); no session open ⇒ `NO_OPEN_SESSION`; a closed session is never reopened or written. Historical cash (before activation) stays **unattributed** and is reported by the window reconciliation as `MISSING_MOVEMENT`; recommended: a **cut-over timestamp** after which the reconciliation is expected to be clean.

## 6. Refund handling

- Source event: the immutable `refund` row written by `executeLocalRefundInTx`; the drawer movement is `CASH_REFUND`, **negative**, source `REFUND` / refund id, same transaction.
- The refund's accounting is **untouched**: its own single journal (`Dr LIABILITY.CUSTOMER_ADVANCES / Cr ASSET.CASH_ON_HAND`) is the only posting; the recorder adds **none** (tests compare a fingerprint of every journal row before and after).
- Duplicates: the same refund twice ⇒ `ALREADY_RECORDED`; two partial refunds of one advance ⇒ two movements.
- Not drawer cash: `BANK_TRANSFER` refunds (and the unimplemented card / provider refunds, which the route answers with a side-effect-free 501) record nothing.
- A refund the register refuses rolls back **with** the refund (tested: no refund, no application, no journal, no movement).

## 7. Frozen files the wiring must modify (the patch)

| File                                                                                       | Change                                                                                  |
| ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| `sales/sales-application.service.ts` (3b.9 Checkpoint E, pinned)                           | inject the wiring; one call after `enqueueSaleCompleted`, with the sale's payments      |
| `payments/payment.repository.ts` (3b.5 D)                                                  | `scoped` callback becomes `async`; one call after capture (origin `INVOICE_PAYMENT`)    |
| `receivables/customer-receipt.repository.ts` (3b.6 D)                                      | same, origin `CUSTOMER_RECEIPT`                                                         |
| `receivables/refund.repository.ts` (3b.8 D)                                                | same, for the executed refund                                                           |
| `sales/sales.module.ts`, `payments/payment.module.ts`, `receivables/receivables.module.ts` | import `CashRegisterModule` (no cycle: it imports nothing)                              |
| _new, not frozen:_ `cash-register/cash-source-wiring.repository.ts` + module registration  | the single entry point, policy-gated; **shipped default `OFF` = zero behaviour change** |

`atomic-walk-in-sale.service.ts`, `payment-collection.repository.ts`, `refund-execution.repository.ts`, every posting file, and every migration are **not** touched. Pins that then need a visible amendment: the 3b.9 Checkpoint E "thin facade" pins, and this work's own "not wired" pins (`cash-sales-e5.structural.test.ts`), which flip to "wired exactly here".

## 8. Database migrations

**None required.** Recommended hardening, **only with approval**: a partial unique index `cash_movement (tenantId, sourceKind, sourceId) WHERE type IN ('CASH_SALE','CUSTOMER_PAYMENT','CASH_REFUND')` so the one-per-source rule is a property of the data and not only of the code. Optional: a terminal column on `payment` for terminal-level (rather than branch-level) source reconciliation.

## 9. Rollback and reconciliation

- **Rollback:** the wiring is behind `CASH_SALES_POLICY` (`OFF` / `POS_STRICT` / `ALL_STRICT`); setting `OFF` stops all drawer writes with no data change. Movements already written are append-only and stay; a wrong run is corrected by an `ADJUSTMENT` (needs decision B-series) — never by deletion.
- **Reconciliation:** `reconcileSession` (each source-backed movement exists at the source, is cash, same amount, same branch) and `reconcileBranchWindow` (every cash source row has exactly one movement of the right amount; no orphan movement). Both read-only; they detect all four injected faults in the tests. Recommended: run before every close and daily per branch; any discrepancy blocks the close until explained.

## 10. Financial acceptance tests (all exist and pass; they must also pass AFTER the wiring)

Full cash sale · partial / split tenders (cash + card, two cash) · all-non-cash sale needs no register · invoice payment and receipt · cash refund · BANK refund records nothing · failed sale leaves nothing · register refusal rolls the whole sale back · duplicate and concurrent twins · concurrent checkout vs close (both orders) · cross-tenant / cross-branch / wrong terminal / wrong device · blocked and revoked device · late event · journal non-duplication (fingerprint identical) · whole shift reconciles and closes at zero variance · without the wiring a cash shift cannot close.

## 11. Decisions required — separated by authority

### Owner (business policy)

| #     | Question                                                                                 | Options                                                                                                                                                                                                                                        |
| ----- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E5-O1 | Approve **direct transactional integration** as the mechanism (§3)                       | **A ★** yes · B outbox consumer (not recommended)                                                                                                                                                                                              |
| E5-O2 | What happens when the register refuses a cash source?                                    | **A ★ `POS_STRICT`**: a verified POS terminal needs an open session, else the sale / payment / refund is refused (409) and rolls back · B `ALL_STRICT` (Owner Web cash is refused too) · C record-if-possible, never refuse (drawer can drift) |
| E5-O3 | A cash payment from a session **without** a verified device (Owner Web, legacy terminal) | **A ★** allowed, no drawer movement (reported by the window reconciliation) · B refused                                                                                                                                                        |
| E5-O4 | A sale while the register is **COUNTING**                                                | **A ★** refused (S-2 default) · B allowed                                                                                                                                                                                                      |
| E5-O5 | The terminal of record                                                                   | **A ★** the **completing** terminal (verified session) · B the order's origin terminal                                                                                                                                                         |
| E5-O6 | Cut-over for historical cash                                                             | **A ★** a recorded timestamp; earlier cash stays unattributed and is excluded from reconciliation                                                                                                                                              |
| E5-O7 | Approve the frozen-contract amendment (§7) and the pin amendments                        | yes / no                                                                                                                                                                                                                                       |
| E5-O8 | Approve the optional hardening index (§8)                                                | yes / no (needs a migration)                                                                                                                                                                                                                   |

### Accountant

| #     | Question                                                                                                                | Options                                                                           |
| ----- | ----------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| E5-A1 | Confirm the drawer ledger is a **sub-ledger**: movements carry **no** journal; the sale / refund journals are unchanged | **A ★** confirm                                                                   |
| E5-A2 | Confirm types and signs (§2): `CASH_SALE` +, `CUSTOMER_PAYMENT` +, `CASH_REFUND` −                                      | **A ★** confirm                                                                   |
| E5-A3 | Reconciliation tolerance                                                                                                | **A ★** none (a one-minor-unit difference is a difference)                        |
| E5-A4 | A discrepancy found before a close                                                                                      | **A ★** blocks the close until explained (the close already refuses any variance) |

### Security sign-off

| #     | Confirmation                                                                                                                                                                            |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E5-S1 | Terminal, device, tenant and actor come only from the verified `RequestContext`; no request field names a terminal, amount or register (pinned: the recorder's input has no such field) |
| E5-S2 | The device must be `ACTIVE` in the database at record time; block / revoke stop cash immediately (tested)                                                                               |
| E5-S3 | Rule 31 preserved: every path is online-only; no offline acceptance mechanism is introduced; no operation proof is activated                                                            |
| E5-S4 | Tenant and branch isolation: RLS on every read and write; cross-branch and cross-tenant attempts are refused with no write (tested)                                                     |

## 12. Validation of the patch (done without touching the real tree; the final, formatted patches and results are in `E5-FINAL-APPROVAL-PACKAGE.md` §4)

- `git apply --check` against the working tree: **clean** (9 files).
- Applied to a scratch copy of `apps/api`: **`tsc` clean**; the real sale / payment / customer-sale integration suites (**sales.controller 153, atomic walk-in 100, atomic customer 165, payment.controller 20**) plus the 32 E-5 tests = **470 passed, 0 failed** with the shipped default policy `OFF` (the patch changes no existing behaviour).
- Pins the patch will require amending (visible edits, by search): `task-3b9-checkpoint-{a,b,c,d,e,f}-structural` (they pin `SalesApplicationService`, `SalesModule`, `PaymentModule`, `ReceivablesModule` — "imports exactly the five modules" in E), `task-3b8-hard-gate-structural` (`refund.repository`), and this work's `cash-sales-e5.structural` "not wired" pins. Full structural re-run is part of the post-approval verification.
