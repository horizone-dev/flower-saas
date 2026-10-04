# TASK-3B9-PLAN.md — Task 3b.9 Atomic Walk-in Sale

> Status: **owner decisions frozen 2026-10-03; Checkpoint A (pure foundation) delivered; Checkpoints B–F not
> started.** Governing documents: [`PHASE-3B-PLAN.md`](PHASE-3B-PLAN.md) (§B row 3b.9, §C.9 "no new table",
> §G `HG3b-ATOMIC-SALE`), [`ADR-0019`](../decisions/ADR-0019.md), and the decision-log rows `3b.9-ACC` and
> `3b.9-OD` in [`DECISION-LOG.md`](../decisions/DECISION-LOG.md). Task 3b.8 is complete and frozen.

## 1. What the task is

One public operation takes an existing **DRAFT** walk-in order to a fully resolved, issued invoice —
order confirmation, tax finalization, gapless numbering, the invoice, the tenders, any advance application,
the accounting, the audit and the outbox events — in **one database transaction**. If any step fails nothing
remains: no confirmed order, no invoice, no burned number, no payment, no journal, no event.

No migration is planned (**no migration 50**). `journal_entry.sourceKind` is free text, so the new
`walk_in_sale` source kind needs no schema change.

## 2. Owner rulings (authoritative)

| ID    | Ruling                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OD-1  | Locally confirmable tenders only: `CASH`, `BANK_TRANSFER`, `OTHER_MANUAL` (the frozen tender→GL mapping supports it → `ASSET.PAYMENT_CLEARING`), manual non-provider `CARD_TERMINAL` (the existing synchronous local-slip path). `ONLINE_GATEWAY` / provider-backed terminals are out of scope; no provider I/O inside the sale transaction.                                                                                                                                                                                                                                                                                                                                      |
| OD-2  | Anonymous WALK_IN (`customerId = null`): PAY_NOW only, zero outstanding, no CustomerAdvance, no credit. Identified customer: PAY_NOW, ON_CREDIT, CustomerAdvance where authorized. Never a fake walk-in customer.                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| OD-3  | The anonymous journal uses the SAME net-of-discount revenue convention already frozen in 3b.6 / 3b.8: `Dr` tender accounts, `Cr REVENUE.SALES`, `Cr LIABILITY.TAX_PAYABLE`. Recorded as decision `3b.9-ACC`; CLAUDE.md rule 20 carries the clarification.                                                                                                                                                                                                                                                                                                                                                                                                                         |
| OD-4  | A read-only canonical totals preview `GET /v1/companies/:companyId/branches/:branchId/orders/:orderId/totals`, sharing EXACTLY the pure computation used by issuance. Never authoritative after the order version changes; completion recomputes under lock.                                                                                                                                                                                                                                                                                                                                                                                                                      |
| OD-5  | `POST /v1/companies/:companyId/branches/:branchId/orders/:orderId/complete-sale` finalizes an existing DRAFT order. No one-shot create + complete.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| OD-6  | Optional DTO field `creditLimitExceptionReason` — a REASON only. No `creditOverride` boolean, no client-selected bypass. The server decides whether a credit-limit exception is required; if so: `customers:credit:override` (Owner-only), step-up, the `authorize()` path, a bounded audited reason. If none is required the field creates no authority.                                                                                                                                                                                                                                                                                                                         |
| OD-7  | One bounded coarse event `orders.sale_completed`. The frozen `payments.*` events still emit naturally. Everything co-commits.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| OD-8  | **Task-scope limitation + RELEASE BLOCKER (§6).** 3b.8 is not reopened; no workaround is invented.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| OD-9  | No cash rounding or change-making. The applied tender amount is exact (Phase 4 owns both).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| OD-10 | An advance inside a sale requires `receivables:advance:apply`. Cashier / Sales do not gain it implicitly.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| OD-11 | A small `sales` module for the orchestrator; only the minimum additive provider exports from frozen modules; no circular module dependency.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| OD-12 | No staff-attribution table or row. Record the existing acting-user / created-by identifiers only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| OD-13 | Recovery read: an additive, read-only issued-invoice summary on the existing Order GET, field name **`issuedInvoice`** (`orders:view`): invoice id, number, date, total, payment status — sourced from the ISSUED invoice only (no second financial source of truth).                                                                                                                                                                                                                                                                                                                                                                                                             |
| OD-14 | **Credit limit applies to resulting receivable exposure, not gross invoice total, for atomic customer sales** (owner ruling at the Checkpoint D correction; decision `3b.9-CE`): `existingOutstanding + finalSaleOutstanding <= creditLimit`, where `finalSaleOutstanding = invoiceTotal − same-sale tenders − same-sale CustomerAdvance applications`, unless the frozen authorized override path approves the excess. PAY_NOW exposure is 0 (no credit consumed). The value is computed internally (never from the client), decided under the account lock BEFORE any number is allocated, and proven equal to the committed state. Historical 3b.6 behaviour is not rewritten. |

### Fully resolved (frozen)

- **PAY_NOW** — tender + eligible advance application == the final invoice total exactly; outstanding = 0.
- **ON_CREDIT** — an identified customer is required; the credit gate succeeds; any provided tenders / advance
  applications are applied; final outstanding > 0; the remainder is the valid customer receivable.
- **Anonymous** — PAY_NOW only; outstanding = 0.
- **Credit is never a payment or tender.**
- **Credit-limit basis (OD-14)** — the resulting receivable exposure (existing outstanding + this sale's final outstanding), never the gross invoice total.

## 3. Checkpoints

| #   | Delivers                                                                                                                                                                                                                                                                                                                                                                  | Status   |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| A   | Pure foundation, no DB: `orders/canonical-totals.ts` (the one shared totals computation, extracted behaviour-preservingly from `TaxFinalizationService`, + the preview wire shape), `sales/sale-plan.ts` (pure validator), `sales/walk-in-sale-journal.ts` (pure journal plan), `orders/order-invoice-summary.ts` (recovery-read projection), structural pins, this plan. | **done** |
| B   | `walk_in_sale` journal posting through `PostingEngineService` (repository-level, caller transaction), DB-level balance / source-idempotency / dimension proofs.                                                                                                                                                                                                           | **done** |
| C   | The orchestrator in the new `sales` module: anonymous PAY_NOW composition (issuance + synchronous capture + journal + audit + outbox in one caller transaction), composition spike first, rollback matrix by fault injection.                                                                                                                                             | **done** |
| D   | Customer-linked sales: PAY_NOW, ON_CREDIT (+ the OD-6 exception path), CustomerAdvance application; credit-limit (tested on the resulting receivable exposure — OD-14) and advance concurrency.                                                                                                                                                                           | **done** |
| E   | HTTP: the `totals` preview route, the `complete-sale` route, DTOs, idempotency, permissions / step-up, the Order GET `issuedInvoice` recovery summary, `orders.sale_completed`, cross-tenant / branch probes.                                                                                                                                                             | **done** |
| F   | Hard gates `HG3b-ATOMIC-SALE`, structural pins, full regression, documentation.                                                                                                                                                                                                                                                                                           | verified |

## 4. Composition risks — each MUST be proven by a named later test

These are the things the discovery pass found that no earlier task ever exercised. Checkpoint A deliberately
does not solve them; each is a gate on the checkpoint named. `task-3b9-checkpoint-a-structural.test.ts` pins that
this table is present and complete.

| ID   | Risk                                                                                                                                                                                                | Proven in | Required proof (planned test)                                                                                                                                                                                                                                                                                     |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CR-1 | Invoice issuance (`TaxFinalizationService.finalizeAndIssueInvoice`) and synchronous capture (`PaymentCollectionRepository.captureSynchronousTendersInTx`) have never run in ONE caller transaction. | C         | `composition spike`: one `ScopedRepository.scoped` transaction issues an invoice for a DRAFT order and captures 1..N tenders against it; the order's lock (`FOR UPDATE`, then `lockOrderThenInvoiceInTx`'s `FOR SHARE`), the not-yet-visible invoice row and the payment-attempt FK to the order do not conflict. |
| CR-2 | The anonymous payment / status path must not accidentally require Customer AR.                                                                                                                      | C         | `anonymous sale creates zero customer_receivable / customer_account_entry / projection rows, still derives invoicePaymentStatus (PAID, or SETTLED for CASH / BANK_TRANSFER), and posts exactly one walk_in_sale journal`.                                                                                         |
| CR-3 | A customer-linked sale must reuse the frozen 3b.6 AR / receipt / allocation / advance journals untouched.                                                                                           | D         | `customer-linked sale posts invoice_ar + customer_receipt_payment + payment_allocation (+ customer_advance_application) exactly as the standalone routes do, and NO walk_in_sale entry`.                                                                                                                          |
| CR-4 | The canonical lock hierarchy (order → invoice → financial child rows; account before advance) has no inversion against payments, cancellation, receipts and advance application.                    | C, D      | `lock-order matrix`: concurrent sale × sale, sale × cancel (pre-invoice), sale × direct payment, sale × advance application, sale × FIFO receipt — zero `40P01`, zero 500, deterministic outcomes (no deadlock-translation workaround).                                                                           |
| CR-5 | Company document-counter serialization (gapless numbering holds the counter row until commit) must be MEASURED, not assumed.                                                                        | C         | `counter serialization`: N parallel sales on one company produce N contiguous order and invoice numbers, no duplicates, no gaps, and the measured per-sale hold time / throughput is recorded in the checkpoint report.                                                                                           |
| CR-6 | A late journal / audit / outbox failure must roll back the invoice number and ALL money.                                                                                                            | C         | `fault injection` at every step after the first write (counter allocation, invoice insert, each tender, advance application, journal, audit, outbox): no order/invoice/number/payment/allocation/journal/audit/outbox row survives and the numbers are re-issued gaplessly on retry.                              |
| CR-7 | Cancellation vs finalization race must have deterministic allowed outcomes.                                                                                                                         | C         | `race matrix`: pre-invoice cancel racing complete-sale on one DRAFT order yields exactly one of {order CANCELLED, no invoice} or {order CONFIRMED, invoice, no cancel}; never both, never a partial state; the loser gets a clean 409.                                                                            |

## 5. Known fail-closed limits (decided, not hidden)

- A **zero-value** sale is rejected (`SALE_ZERO_TOTAL_NOT_SUPPORTED`): the database allows a zero invoice
  total, but no balanced journal can be posted for it. **Owner ruling (Checkpoint B): Task 3b.9 does NOT
  support a zero-total finalized sale.** The rejection stays at BOTH the pure plan (`planSale`) and the
  posting adapter (before the posting engine is reached); no empty / zero-value journal is created and no
  complimentary-sale accounting is invented. That is deferred to a later, explicit product + accounting
  decision. (Identifiers stay distinct: `3b.9-ACC` = the accounting convention decision, `3b.9-OD` = the
  owner decisions OD-1…OD-13, `RB-1` = the anonymous issued-sale void / refund release blocker.)
- No overpayment / change-making / cash rounding (OD-9).
- A draft order stores no total; the client learns the amount to collect from the OD-4 preview (Checkpoint E).
  Until then the pure computation is the only authority.
- Anonymous sales cannot yet be voided or refunded — see §6.

## 6. Release blockers

> **RB-1 (OD-8) — anonymous issued-sale void / refund resolution.**
> An issued anonymous sale cannot use the existing CreditNote / refund path: Task 3b.8 requires a
> customer-linked order (a CreditNote funds a CustomerAdvance on a customer account), and 3b.8 is frozen.
> Task 3b.9 may complete anonymous PAY_NOW sales under that constraint, and invents **no** workaround.
> **Anonymous issued-sale void / refund resolution must be designed and completed before any production / MVP
> release that enables anonymous sales.**

## 7. Checkpoint A — what exists

| File                                                     | Role                                                                                                                                                                             |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/api/src/modules/orders/canonical-totals.ts`        | The ONE pure tax / discount / rounding computation. `TaxFinalizationService` calls it under the order lock; the OD-4 preview will call the same function. No duplicated formula. |
| `apps/api/src/modules/sales/sale-plan.ts`                | Pure `planSale`: intent / customer / tender / advance validation → one deterministic, frozen plan.                                                                               |
| `apps/api/src/modules/sales/walk-in-sale-journal.ts`     | Pure anonymous `walk_in_sale` journal plan (net-of-discount convention).                                                                                                         |
| `apps/api/src/modules/orders/order-invoice-summary.ts`   | Pure projection of the ISSUED invoice to the five recovery fields.                                                                                                               |
| `*.test.ts` + `task-3b9-checkpoint-a-structural.test.ts` | Equivalence, invariants, journal examples, scope pins.                                                                                                                           |

## 8. Checkpoint B — what exists

| File                                                            | Role                                                                                                                                                                                                                                                                                                           |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/api/src/modules/sales/walk-in-sale-journal.repository.ts` | Caller-transaction adapter: validates the trusted issued invoice + order context, then posts the Checkpoint-A `walk_in_sale` plan through the frozen `PostingEngineService`. Opens no transaction, performs no I/O, owns no accounting formula. Not yet wired into any Nest module (Checkpoint C composes it). |
| `walk-in-sale-journal.repository.integration.test.ts`           | Real-PostgreSQL proof: journal examples, replay / conflict / concurrency, caller rollback + fault injection, period / currency fail-closed, trusted scope, customer-linked and zero-total guards.                                                                                                              |
| `task-3b9-checkpoint-b-structural.test.ts`                      | Closed-world pins: the adapter is the only new production file; no route / module / orchestrator, no second journal writer, no formula, provider, inventory, advance, AR, permission, float or migration 50.                                                                                                   |

Findings recorded for Checkpoint C (no migration 50 was needed):

- **Idempotency is the existing `(tenant, company, sourceKind, sourceId)` unique index** plus the engine posting fingerprint:
  same invoice + same plan replays (`created: false`); same invoice + a different plan is `JOURNAL_SOURCE_CONFLICT` (409);
  two concurrent posts serialise on the unique index (never `40P01`, never a raw 500).
- **The journal is dated with the invoice's own `invoiceDate`** (passed as the explicit `accountingDate`). A replay
  AFTER that accounting period was closed therefore fails closed with `ACCOUNTING_PERIOD_CLOSED` (the engine validates
  the period before it can replay) rather than silently re-posting; Checkpoint C must not rely on re-calling the adapter
  for an old sale — an idempotency-key replay must return the stored response.
- **Two guards the DB already makes unconstructible:** a `customer_receivable` can never reference an anonymous invoice,
  and an issued order's `customerId` / `kind` / POS terminal / currency are frozen; the invoice currency is FK-bound to
  the company accounting currency. The adapter still fails closed on each (the currency check is proven with the FKs
  dropped in the disposable test container); both DB facts are pinned by tests.
- The adapter is a primitive over the caller's `ScopedTx`: invoice issuance, tender capture, the sale audit / outbox
  event and the HTTP surface remain Checkpoint C / E work.

## 9. Checkpoint C — what exists (anonymous PAY_NOW atomic orchestration)

| File                                                              | Role                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/api/src/modules/sales/atomic-walk-in-sale.service.ts`       | `AtomicWalkInSaleService` — the ONE internal orchestrator. `completeAnonymousPayNowInTx(tx, input)` composes the four frozen primitives on a caller-owned scoped transaction; `completeAnonymousPayNowForBranchScoped(input)` is the conventional entry point (tenant + actor from the `RequestContext`, exactly ONE scoped transaction). Owns no arithmetic, writes no row itself, performs no I/O, is registered in no Nest module. |
| `apps/api/src/modules/orders/tax-finalization.service.ts`         | The narrow split: `prepareFinalization` (lock order + lines, run the ONE canonical computation — writes nothing, allocates no number) and `issuePrepared` (the issuance call). `finalizeAndIssueInvoice` is now exactly the two in sequence — behaviour unchanged (the whole 3b.4 suite still passes; a twin-order equivalence test pins it).                                                                                         |
| `sales/atomic-walk-in-sale.composition-spike.integration.test.ts` | The composition spike, written BEFORE the orchestrator.                                                                                                                                                                                                                                                                                                                                                                               |
| `sales/atomic-walk-in-sale.integration.test.ts`                   | Real-PostgreSQL proof: the money / tax / tender matrix, gates, isolation, the A–I fault-injection matrix, numbering, duplicate-finalize / cancel-vs-complete / different-order concurrency, audit / outbox boundary, the observed lock-order pin.                                                                                                                                                                                     |
| `sales/task-3b9-checkpoint-c-structural.test.ts`                  | Closed-world pins; content-hash pins that the A / B production files are untouched.                                                                                                                                                                                                                                                                                                                                                   |

### Sequence (one transaction, nothing numbered until the request is valid)

1. lock the order `FOR UPDATE` in exact tenant / company / branch scope; gate `status = DRAFT` → `version` → `kind = WALK_IN` → `customerId IS NULL`
2. `prepareFinalization` — the canonical totals over the locked rows
3. `planSale` (pure) against the FINAL total — **a bad request burns no order / invoice number**
4. `issuePrepared` — order + invoice numbers, the immutable invoice
5. `captureSynchronousTendersInTx` — one attempt / event / Payment / Allocation per tender; the invoice payment status is derived by the frozen projection
6. coverage check: monetary outstanding is 0 and the derived status is PAID or SETTLED
7. `buildWalkInSaleJournal` + `postWalkInSaleJournalInTx` — the ONLY sale-revenue GL

### Observed lock order (pinned by an exact trace in the integration test)

```
order FOR UPDATE            the orchestrator's gate — the very first lock
order FOR UPDATE, lines     prepareFinalization   (already held: no-op)
order FOR UPDATE, lines     issuance revalidation (no-op)
company ORDER counter → company INVOICE counter → order UPDATE → invoice INSERT
order FOR SHARE             capture: a no-op downgrade of the lock the sale already holds
invoice FOR UPDATE          capture — ORDER before INVOICE
payment_attempt / payment / payment_allocation inserts
company FOR SHARE → accounting_period FOR SHARE      the walk-in adapter / posting engine
```

Compared with the frozen F4 graph (`payment-target-lock.repository.ts`): post-invoice cancellation locks
`order(UPDATE) → invoice(UPDATE) → …`, a direct payment locks `order(SHARE) → invoice(UPDATE) → …`, issuance locks
`order(UPDATE) → … → NEW invoice`. The composed sale takes the order first and the invoice only after it exists, so there is
**no Invoice → Order inversion**: a concurrent cancellation and a sale serialise on the order row and exactly one wins. No
`40P01` translation exists or is needed (0 deadlocks across the duplicate-finalize, cancel-vs-complete and different-order races).

### Derived payment statuses (observed — never forced)

| Tenders                                                              | `invoicePaymentStatus`                                            |
| -------------------------------------------------------------------- | ----------------------------------------------------------------- |
| CASH, BANK_TRANSFER, CASH + CASH, CASH + BANK (also KWD)             | `SETTLED` (CASH / BANK_TRANSFER are settlement-final immediately) |
| manual CARD_TERMINAL, OTHER_MANUAL, any Multi Payment containing one | `PAID` (not settlement-final: PAID ≠ SETTLED is preserved)        |

### Company document-counter serialization (CR-5 — measured, not optimised)

The gapless ORDER and INVOICE counters are taken after the lines are locked and held until commit — about 85 % of a sale
(median ≈ 90–135 ms held of ≈ 105–170 ms on the test container). Sixteen concurrent sales of ONE company took ≈ 1.8 s (fully
serialised, ≈ 7–11 sales/s); sixteen spread over four companies took ≈ 0.63 s. It is **correctness-only serialisation** (gapless per-company numbering requires it) and per company. These figures are a
**non-production benchmark** — one run on a local Docker test container, with Prisma interactive transactions and a cold
connection pool — and are NOT a production capacity guarantee. They are recorded as an observation only; the counter was not
optimised. A later Phase-3 final hard gate, **HG3b-SALE-LATENCY**, re-measures transaction and counter latency under a
representative environment (PHASE-3B-PLAN §G). The obvious future lever — allocating the numbers later in the transaction —
would reorder frozen issuance.

### Findings recorded for Checkpoints D / E

- **Frozen replay rule (Checkpoint E):** a successful HTTP idempotency replay MUST return the stored successful response BEFORE
  re-running any sale / orchestrator / journal logic. Do not make `WalkInSaleJournalRepository` replay after its period has closed.
- `operationKey` is an opaque value passed to every PaymentAttempt as historical context. It is **not** an idempotency claim.
- **Branch isolation of these tables is explicit predicates + the guard pipeline, not RLS.** The `app.branch_id` GUC policy exists
  only on the branch-pricing tables; orders, invoices, payments and journals narrow by tenant RLS plus the explicit
  `tenantId / companyId / originBranchId` predicates every frozen primitive uses. Checkpoint E's route MUST obtain `branchId`
  through `@ScopedParam({ branch })` so the guard checks it against the session before it reaches this service.
- The database already makes unconstructible: an order carrying another branch's POS terminal (`order_pos_tenant_company_branch_fkey`),
  a receivable on an anonymous invoice, a changed customer / kind / terminal / currency on an issued order. The orchestrator
  therefore carries no check of its own for them (pinned by tests instead).
- The orchestrator's own invariants guard what the frozen collaborators RETURN (a receivable id, a non-zero remainder, a status
  other than PAID / SETTLED, a journal replay for a new invoice); each is proven by a test that doctors that collaborator's output.

### Still NOT in Checkpoint C

HTTP controller / route / DTOs, the public idempotency claim and replay, permissions and step-up, the `orders.sale_completed`
outbox event, the recovery-read wiring, customer-linked sales, ON_CREDIT, CustomerAdvance, provider execution, inventory, a Nest
module, migration 50. **RB-1 stays open:** an issued anonymous sale still cannot be cancelled, voided or refunded (the frozen 3b.8
restriction `WALKIN_POST_INVOICE_CANCELLATION_NOT_AVAILABLE` answers, and a test pins it).

## 10. Checkpoint D — what exists (identified-customer orchestration)

| File                                                               | Role                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/api/src/modules/sales/atomic-walk-in-sale.service.ts`        | The SAME `AtomicWalkInSaleService`, extended narrowly: `completeCustomerSaleInTx(tx, …)` + `completeCustomerSaleForBranchScoped(…)` for an IDENTIFIED-customer order, with three more frozen collaborators (`CustomerInvoiceArRepository`, `CustomerAdvanceApplicationRepository`, `CreditOverrideAuthorizationService`). The anonymous methods are byte-identical (content-hash pinned). |
| `apps/api/src/modules/sales/sale-authority.ts`                     | PURE metadata: which already-registered permission keys a sale's composed effects correspond to (`payments:collect`, `receivables:advance:apply`, `customers:credit:override`). Enforces nothing; adds no permission.                                                                                                                                                                     |
| `sales/atomic-customer-sale.composition-spike.integration.test.ts` | The lock-order spike, run BEFORE any orchestrator code.                                                                                                                                                                                                                                                                                                                                   |
| `sales/atomic-customer-sale.integration.test.ts`                   | Real-PostgreSQL proof: PAY_NOW / ON_CREDIT matrices, gates, advance and credit-limit matrices (incl. the concurrent races), the A–J fault matrix, numbering, isolation, the read model, the observed lock order, and 3b.8 cancellation compatibility.                                                                                                                                     |
| `sales/task-3b9-checkpoint-d-structural.test.ts`                   | Closed-world pins; content-hash pins of every frozen surface D reuses.                                                                                                                                                                                                                                                                                                                    |

### The accounting model — the frozen 3b.6 set, never `walk_in_sale`

A customer sale posts exactly: `invoice_ar` (Dr AR / Cr REVENUE.SALES / Cr TAX_PAYABLE) at issuance;
per tender `customer_receipt_payment` (Dr tender / Cr UNAPPLIED_RECEIPTS) + `payment_allocation`
(Dr UNAPPLIED_RECEIPTS / Cr AR); per advance `customer_advance_application` (Dr CUSTOMER_ADVANCES / Cr AR). The
walk-in journal is reachable from the anonymous primitive ONLY (a pin counts the call sites). Credit is never a Payment: a
credit sale simply leaves the remainder as the customer receivable. The books agree with the receivable: the AR lines of
these journals net to the sale's remaining outstanding, and every receipt is fully allocated.

### Sequence (one transaction; everything refusable is refused before a number is allocated)

1. order lock + gate: `DRAFT` → version → `WALK_IN` → `customerId` PRESENT (the order's persisted customer is the only customer)
2. `prepareFinalization` — canonical totals (writes nothing)
3. `planSale` (pure): intent, tenders, advances, PAY_NOW conservation, ON_CREDIT remainder (`SALE_ON_CREDIT_FULLY_COVERED` — never auto-converted); then the sale's **`finalSaleOutstanding`** (total − tenders − advances) is taken from the plan and its conservation re-proven against the canonical total
4. customer pre-flight under the account lock: the frozen credit gate **on `finalSaleOutstanding`** (existing outstanding + this sale's remainder against the limit); the override only if the server finds it necessary
5. advance pre-check: exists for this customer's account in THIS branch, same currency, enough available balance
6. `issuePrepared` — numbers, invoice, receivable, `invoice_ar` journal (the frozen issuance gate runs again, already held, on the SAME exposure through one optional trusted parameter)
7. advance applications in ASCENDING advance-id order (frozen `applyInTx`)
8. local tenders (frozen capture) — only when real tenders exist
9. coverage check: the invoice outstanding equals `finalSaleOutstanding` and the derived status is allowed for the intent — **and the customer account's stored outstanding equals the locked existing outstanding + `finalSaleOutstanding`** (the credit tested is the credit committed; any difference rolls the whole sale back)

### Credit gate and the override

The gate is the FROZEN 3b.6 one: it compares (the customer's existing receivable outstanding + the amount this sale ADDS) with
the limit, before any document number is allocated. **That amount is the sale's resulting receivable exposure — the invoice total
minus its same-sale tenders and advances — not the gross invoice total (OD-14, below).** A credit enabled with no limit (null triplet) is
unlimited; credit disabled is an unconditional block that no override can lift. When the gate denies a sale **the server has
determined an override is necessary**; only then, and only if `creditLimitExceptionReason` was supplied, is the frozen
`CreditOverrideAuthorizationService.authorize` consulted (permission + step-up + a non-empty reason of at most 255 chars). A
reason on a sale that needs none is ignored; with no reason the denial stands; there is no boolean, no `force`, and forged
override-shaped input is never read. The override is single-use, audited (`credit_limit.override_used`, the actor, the
bounded reason) and rolled back with the sale.

### Credit-limit basis correction (OD-14 / decision `3b.9-CE`)

**Owner ruling: "Credit limit applies to resulting receivable exposure, not gross invoice total, for atomic customer sales."**

- **Old behaviour (as first delivered, reported as a finding):** the frozen issuance primitive passed the invoice TOTAL to the
  credit gate as the amount to add, so a sale partly covered by a same-sale tender or advance was gated as if the whole invoice
  would become credit.
- **New rule:** `existingOutstanding + finalSaleOutstanding <= creditLimit`, where
  `finalSaleOutstanding = invoiceTotal − same-sale tenders − same-sale CustomerAdvance applications` (invoice 1 000: cash 700 → 300;
  advance 400 → 600; cash 300 + advance 200 → 500; full ON_CREDIT → the whole total; PAY_NOW → 0, no credit consumed).
  The excess over the limit still needs the frozen authorized override; credit DISABLED is still an unconditional block; credit is still never a Payment.
- **Where the amount comes from:** the orchestrator (`finalSaleOutstanding`) takes the remainder from the frozen pure plan and
  re-proves `tenders + advances + remainder = canonical total` in exact BigInt and one currency; the request supplies none of it.
- **The one frozen-primitive change:** `IssueFinalInvoiceInput` / `FinalizeAndIssueInvoiceInput` gain ONE optional trusted field,
  `finalSaleOutstandingMinor` (validated `0 ≤ x ≤ invoice total`, `ORDER_CREDIT_EXPOSURE_INVALID` otherwise). **Omitted — every other
  caller — the gate keeps the frozen invoice-total basis, unchanged.** The 3b.6 gate primitives (`credit-exposure.ts`,
  `CustomerInvoiceArRepository`) are NOT edited: their input is already "the amount to add". The receivable is still booked for the
  FULL invoice total; tenders and advances then reduce it exactly as before — the journals are unchanged.
  The added lines are marker-delimited, and a pin proves that removing exactly them restores both files byte-for-byte.
- **Decided before any number:** the pre-flight takes the customer-account lock and decides on the exposure BEFORE issuance, so a
  credit denial (or the override decision) burns no document number; issuance's own gate then agrees on the same figure.
- **Proven after the fact:** the invoice balance and the account's stored outstanding must equal the preflight exposure
  (`SALE_CREDIT_EXPOSURE_INVARIANT_VIOLATED`, 500, full rollback). Two sales of one customer serialise on the account lock, so
  500 + 500 against a limit of 1 000 both succeed while 600 + 600 admits exactly one — with tenders, advances or both.
- **Not changed:** the anonymous Checkpoint C path (byte-identical, pinned), 3b.6 behaviour for any caller that does not supply the
  exposure, the permission registry, the schema (no migration 50), the cancellation model, RB-1.
- **Proof:** the D integration suite (real PostgreSQL, 165 tests) covers the exposure matrix (partial tender, advance, tender + advance,
  Multi + advance) at exactly-at-limit / one-unit-over / override, existing outstanding + exposure, PAY_NOW consuming no credit,
  the DISABLED hard block, the owner's concurrency scenarios (500 + 500 against 1 000 both succeed; 600 + 600 admits one; with tenders,
  advances and both; six sales whose invoice alone exceeds the limit), and the issuance parameter contract (omitted = invoice-total
  basis, provided = gate basis only, invalid = `ORDER_CREDIT_EXPOSURE_INVALID`). Doctored-collaborator tests prove the postcondition
  (projection drift, stale existing outstanding) and every guard of `finalSaleOutstanding`. Mutation: 31 exposure mutants + 23
  re-anchored customer-path mutants, all caught by the real-PostgreSQL tests; the structural pins (D: 57) include a restore-to-frozen-hash
  proof for the two issuance files. The anonymous C suite (100), A / B / C pins and the anonymous hash pins are unchanged and green.

### Observed lock order (pinned as an exact trace) — compared with the frozen graphs

```
order FOR UPDATE → order lines             the sale gate + canonical computation
customer ACCOUNT FOR UPDATE                the pre-flight (credit gate) — BEFORE any number
company ORDER counter → INVOICE counter → order UPDATE → invoice INSERT → receivable INSERT → invoice_ar journal
invoice FOR UPDATE → account (held) → ADVANCE FOR UPDATE (ascending id) → application → advance journal
order FOR SHARE (no-op) → invoice FOR UPDATE (no-op) → payment_attempt / payment / payment_allocation → receipt + allocation journals
```

3b.6 (advance application, FIFO receipt): invoice → account → advance/payment. 3b.8 F4 (cancellation, direct payment):
order → invoice → account. The sale takes the account BEFORE an invoice exists (that invoice is unreachable by anyone else
until commit), so no transaction can hold an invoice the sale is waiting for. The competing orders were exercised for real:
sale × sale on one customer, sale × standalone advance application over the same advance, sale × standalone direct payment on
another invoice of the same customer — zero `40P01`, zero raw 500. No inversion; no deadlock translation exists.

### Derived payment statuses (observed — never forced)

| Sale                                                                                               | `invoicePaymentStatus` |
| -------------------------------------------------------------------------------------------------- | ---------------------- |
| CASH / BANK_TRANSFER (alone or with an advance, KWD too)                                           | `SETTLED`              |
| manual CARD_TERMINAL / OTHER_MANUAL (alone, in a Multi Payment with any other, or with an advance) | `PAID`                 |
| advance only (PAYMENT- or OPENING-sourced)                                                         | `SETTLED`              |
| ON_CREDIT with no coverage / any coverage                                                          | `UNPAID` / `PARTIAL`   |

### Compatibility with the frozen Task 3b.8 cancellation (no behaviour added)

A 3b.9 customer sale is a valid 3b.8 input: an unpaid credit sale, a locally paid manual-card sale (PAID), cash + credit,
advance + credit and tender + advance + credit (PARTIAL) all cancel through the real `OrderRepository` + `CreditNoteRepository`
with the projections still agreeing with the books. A CASH / BANK sale (SETTLED) is refused with the frozen
`INVOICE_CANCELLATION_NOT_SUPPORTED` — exactly the state a standalone cash payment already produces, not a new incompatibility.

### Findings recorded for Checkpoint E

- **RESOLVED by owner ruling OD-14 (`3b.9-CE`):** the credit gate was first delivered conservative (an ON_CREDIT sale with a partial
  tender or advance was gated on the full invoice total). The owner ruled the limit applies to the RESULTING receivable exposure;
  the correction is described in "Credit-limit basis correction" above.
- A customer sale holds the customer account lock from the pre-flight until commit: two sales of the SAME customer serialise
  (that is what makes the credit limit and the advance balance race-proof); different customers do not contend.
- An OPENING advance is limited to one per account + branch; any further advance is PAYMENT-sourced (converted from a receipt).
- The frozen policy engine maps NO entitlement module to `customers:credit:override`: it is permission + step-up only.
- `receivables:advance:apply` is reported in the result's `authorities`; Checkpoint E's route must gate it separately and must
  never let it ride on `payments:collect`. `creditLimitExceptionReason` is the frozen client field name; E maps it here.
- The frozen replay rule stands: an idempotent HTTP replay returns the stored response BEFORE any of this runs again.

### Still NOT in Checkpoint D

HTTP controller / route / DTOs, the public idempotency claim and replay, permission decorators and step-up wiring, the
`orders.sale_completed` outbox event, provider execution, inventory, a Nest module, migration 50. **RB-1 stays open:** an issued
ANONYMOUS sale still cannot be cancelled, voided or refunded.

## 11. Checkpoint E — what exists (the public surface of the atomic sale)

Checkpoint E exposes the frozen A–D core over HTTP and changes **no financial behaviour**: the orchestrator, the corrected
credit-exposure rule, the journals, the idempotency system, the global guard pipeline, the outbox writer and the realtime
authorization are all byte-identical (content-hash pins). `finalSaleOutstandingMinor` and `operationKey` are never client-visible.

| File                                                                       | Role                                                                                                                                                                       |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sales/sales.module.ts`                                                    | Imports Order / Payment / Receivables / Accounting / Access modules; re-declares none of their providers; no export, no cycle, no `forwardRef`.                            |
| `sales/sales.controller.ts`                                                | `POST …/orders/:orderId/complete-sale` and `GET …/orders/:orderId/totals`. Delegates only.                                                                                 |
| `sales/dto/complete-sale.dto.ts`                                           | Strict body: `paymentIntent`, `tenders[]`, `advanceApplications[]`, optional `creditLimitExceptionReason`. Mirrors the frozen tender / advance DTO conventions.            |
| `sales/complete-sale-authority.guard.ts`                                   | Route guard: `payments:collect` for real tenders, `receivables:advance:apply` for advance applications — runs BEFORE any idempotent replay.                                |
| `sales/complete-sale-fingerprint.provider.ts`                              | The shared idempotency system's opt-in hook: the semantic fingerprint includes `If-Match`.                                                                                 |
| `sales/sales-application.service.ts`                                       | The thin facade: dispatch on the order's persisted customer, the one sale transaction, `orders.sale_completed` in that transaction, response assembly. No financial logic. |
| `sales/complete-sale-response.ts`, `sales/sale-events.ts`                  | Pure response mapper (money as strings, no internals); the one event type + its two-field payload.                                                                         |
| `sales/order-totals-preview.repository.ts` / `.service.ts`                 | The read-only canonical totals preview (one statement, no lock, the ONE Checkpoint-A computation).                                                                         |
| `orders/order.repository.ts` (+ service, controller), three module exports | The additive `issuedInvoice` recovery read on Order GET (marker-delimited; the frozen repository text is restored byte-for-byte by a pin); additive exports only.          |

### Discovery — the facts the surface rests on

- **A. A replay never reaches the handler.** `IdempotencyInterceptor` returns the stored snapshot without calling `next.handle()`: the facade,
  orchestrator, journal adapter, accounting-period validation, payment logic and numbering do not run.
- **B. Guards run before replay.** The global `AuthGuard` / `PermissionGuard` and the route-level guard all run before interceptors, so
  `orders:manage`, entitlement, company / branch scope and the conditional tender / advance authority are enforced on every replay too.
- **C. `If-Match` is NOT in the default fingerprint** (method, route, path params, query, scope, tenant, principal, body). The repository's own opt-in
  `semanticFingerprintProvider` hook receives the full request before any claim and is used to bind it — no change to the shared system.
- **D. Nested operation identity.** The frozen payment path already passes the request `Idempotency-Key` as the payment attempts' `idempotencyKey`;
  `complete-sale` reuses exactly that as the server-owned `operationKey` (the unique index on it is partial — provider-backed attempts only).
- **No persistence gap:** the idempotency store and the outbox's company / branch columns already existed (migrations unchanged: 49). Neither the worker's
  dispatcher nor the realtime gateway has an event-type allow-list — they relay and authorize by the envelope's tenant / company / branch only, so the new
  event needed no registry change.

### The routes

- **`POST /v1/companies/:companyId/branches/:branchId/orders/:orderId/complete-sale`** — `orders:manage`, `@ScopedParam({ company, branch })`, **`Idempotency-Key`
  and `If-Match` required**, status **200** (a command on an existing order, like hold / resume / cancel). One route: the ORDER's persisted `customerId`
  selects the frozen anonymous PAY_NOW path or the frozen customer path — there is no client mode flag.
- **`GET …/orders/:orderId/totals`** — `orders:view`; read-only, version-bound, advisory (the canonical Checkpoint-A wire shape). Completion always recomputes under the lock.
- **`GET …/orders/:id`** gains `issuedInvoice` (the frozen five-field summary read from the invoice row, or `null`) under the existing `orders:view`.

### Authority — no new permission

`orders:manage` is the route's static authority. Request-dependent authority is a **route guard** (so it also gates a replay): real tenders → `payments:collect`; advance
applications → `receivables:advance:apply` (derived by the frozen pure `saleAuthorityRequirements`, through the one `PolicyEngine`, with the same deny → HTTP mapping as the global guard;
a malformed value fails closed). Credit is not a tender, so an ON_CREDIT request with neither needs only `orders:manage`. The credit-limit override is **not** decided in the controller,
guard or facade: only if the frozen orchestrator finds one necessary does the frozen `authorize()` run (Owner permission + step-up + a bounded audited reason); a reason alone grants
nothing and requires nothing. Verified with the REAL default role grants: cashier / sales — local tenders yes, advance no, override no; manager / admin — advance yes, override no; owner with
step-up — override yes, without step-up no; accountant — no `orders:*`.

### Idempotency (scope `orders.complete_sale`)

Same key + same normalized request → the stored 2xx, flagged `idempotency-replayed: true`, with zero service calls and zero effects (proven by spies on the facade, orchestrator, journal adapter, posting
engine, capture, issuance and advance primitives, and by a full table snapshot). Same key + a changed body, order id, **`If-Match`**, reason or tender order → `409 IDEMPOTENCY_KEY_REUSED`. Another principal never
receives the first one's response. A duplicate while the first is in flight waits and replays (or `IDEMPOTENCY_IN_PROGRESS` past the wait window). A failed execution — early or late, after payments were written — rolls
back everything, writes no event and releases the claim, so the same key retries. After the original accounting period closes, the replay still returns the stored success while a fresh sale is refused. The
request key is the nested `operationKey`; a replay creates no second PaymentAttempt / Payment.

### Findings recorded for Checkpoint F

- **Replay vs recovery.** A response snapshot is stored only for 2xx and for the key's TTL; after the TTL a retry with the same key is a NEW request, finds the order CONFIRMED and is refused with
  `409 ORDER_INVALID_STATE_TRANSITION` — never a second sale. The `issuedInvoice` read on Order GET is the designed recovery path (verified: lost response → read → correct invoice).
- **The frozen interceptor's "mark DONE failed after commit" window** is unchanged (it logs a monitored error); for `complete-sale` a later re-execution cannot double-sell (the order is CONFIRMED).
- **Anonymous + advance request:** the frozen anonymous primitive's input cannot carry an advance, so the facade refuses it with the frozen plan's own code / message / status (a test ties them together).
- **Preview vs 3b.9 totals.** The preview reads order + lines in ONE statement (one snapshot, no lock, never blocks a sale or an edit — tested with a held row lock).
- **`HG3b-SALE-LATENCY` stays open** (a Phase-3 FINAL hard gate); the 7–11 sales/s/company figure remains a local Testcontainers observation, not a capacity claim.
- **RB-1 stays open:** an issued ANONYMOUS sale still cannot be cancelled, voided or refunded.

### Still NOT in Checkpoint E

Provider execution, inventory, any frontend, reporting (Task 3b.10), anonymous refund / void, a new permission, migration 50, the Checkpoint-F full regression and hard-gate closure.

## 12. Checkpoint F — final verification (pre-PR)

Recorded on the final integrated working tree, branch `phase-3/task-3b.9-atomic-walk-in-sale`, base `9e00528`. **Nothing is committed, pushed or opened as a PR** — the complete Task 3b.9 diff awaits one final owner review before the atomic commit.

### Gate results

| Gate                                                                               | Result                                                                                                                                                                                                                                                                                                                |
| ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Frozen A–E structural / hash pins                                                  | green (A 31, B 23, C 25, D 57, E 70, F 31 pins)                                                                                                                                                                                                                                                                       |
| Typecheck (forced, uncached)                                                       | 34 / 34 tasks                                                                                                                                                                                                                                                                                                         |
| Lint (forced, uncached)                                                            | 35 / 35 tasks, 0 errors; 5 pre-existing `no-console` warnings in files this task never touched (Git proves the files unmodified)                                                                                                                                                                                      |
| Format                                                                             | every Task 3b.9 file clean; the only failures are unrelated untracked `.claude/*` files                                                                                                                                                                                                                               |
| Full test (uncached)                                                               | 34 / 34 tasks, 194 files, 4622 tests, 0 failed, 0 skipped; the three web workspaces without tests are the established `passWithNoTests` ones                                                                                                                                                                          |
| Build                                                                              | 21 / 21 tasks (api, the four web apps, realtime / worker / scheduler, packages); compiled app module, both sale routes and decorator metadata confirmed in `dist`                                                                                                                                                     |
| Config negative test, Playwright e2e                                               | pass (e2e boots the built API)                                                                                                                                                                                                                                                                                        |
| Prisma + migration gate                                                            | `validate` / `generate` clean; fresh 1→49, 44→49 and 48→49 upgrades, second deploy a no-op, `migrate status` clean, no schema drift introduced (68 checks); exactly 49 migrations, no migration 50                                                                                                                    |
| Frozen migration hashes (44–49)                                                    | all byte-identical to the Task 3b.8 values; `schema.prisma` and `migration_lock.toml` unchanged                                                                                                                                                                                                                       |
| Security                                                                           | secret-custody scan, OSV (exact), gitleaks (history + tree), Trivy config + filesystem, SBOM — all clean, no ignore file and no suppression                                                                                                                                                                           |
| F structural pin sensitivity                                                       | 49 deliberate violations (migration / hygiene / PII vocabulary / scope / rulings / documentation) — every one turned the F suite red, none vacuous; the tree restored byte-identically                                                                                                                                |
| Idempotency, financial, concurrency, isolation, event, response and recovery gates | the 22 Checkpoint-F HTTP hard-gate tests (anonymous and identified-customer matrices, 2- and 3-decimal currencies, tax-inclusive, corrected credit exposure, override, TTL expiry, duplicate completions, advance double-spend, cancel-versus-complete, gapless numbering) plus the 131 Checkpoint-E tests, all green |

### Performance observation

The Checkpoint-C benchmark was re-run three times on the final tree (same shape: one sequential series, 16 concurrent sales in one company, 16 across four companies).

| Run | Sequential per-sale median | Counter-hold median (sequential) | 16 sales, one company: wall / hold median / hold p95 | 16 sales, four companies: wall | Implied sales / s / company |
| --- | -------------------------- | -------------------------------- | ---------------------------------------------------- | ------------------------------ | --------------------------- |
| 1   | 138 ms                     | 113 ms                           | 2026 ms / 1048 ms / 1915 ms                          | 719 ms                         | 9                           |
| 2   | 122 ms                     | 93 ms                            | 1796 ms / 786 ms / 1524 ms                           | 624 ms                         | 11                          |
| 3   | 138 ms                     | 113 ms                           | 1945 ms / 827 ms / 1717 ms                           | 733 ms                         | 9                           |

The figures sit inside the Checkpoint-C band (7–11 sales / s / company); same-company sales serialize on the company document-counter lock, exactly as designed, and there is no pathological serialization or deadlock. **Local test-container benchmark; not production capacity.** No SLA is claimed. **`HG3b-SALE-LATENCY` stays open** as the Phase-3 final hard gate.

### Still open

- **RB-1** — an issued ANONYMOUS sale still cannot be cancelled, voided or refunded. It must be designed and completed before any production / MVP release (owner ruling OD-8).
- **`HG3b-SALE-LATENCY`** — see above.

### Unrelated observations (not caused by, and not fixed in, this task)

- The five `no-console` lint warnings above.
- Four untracked `.claude/*` files fail the Prettier check.
- Orphaned local `node_modules` directories for two dependencies that were removed from the manifests by the security remediation; they are not in the lockfile or any manifest and are not committed.
- 257 datamodel-versus-SQL differences reported by `migrate diff`; the set is identical on `main`, so Task 3b.9 introduces none.
