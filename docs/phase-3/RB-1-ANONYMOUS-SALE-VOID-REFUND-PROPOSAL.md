# RB-1 — anonymous issued-sale void / refund: DESIGN PROPOSAL (not approved, nothing implemented)

- **Status (latest): OPTION A2 IS IMPLEMENTED LOCALLY (section 9) under owner decisions of 2026-11-11 — uncommitted, not merged, not deployed; no production restriction is active.** Earlier status text follows.
- **Status (updated): section 8 SUPERSEDES the `credit_note.customer_id` migration claim in sections 3, 4 and 7 (that column does not exist); the final recommended contract is option A2 in section 8.** PROPOSAL for owner decision, prepared 2026-11-11 on `phase-3/3b-closure-hardening`. **No code, migration, route,
  permission or posting was written.** RB-1 stays an open release blocker until the owner approves a design, it is built, and the
  acceptance tests below pass.
- **Why a proposal and not a fix:** resolving RB-1 books new money movements (a reversal of revenue, tax and tender receipts) and
  needs either a new document type or a change to the frozen Task 3b.8 cancellation / credit-note contract. CLAUDE.md rule 16–20
  and the owner's own ruling OD-8 ("3b.8 is not reopened; no workaround is invented") make that an owner decision.

## 1. The gap, precisely (verified in the code)

- An anonymous WALK_IN sale (`customerId = null`, PAY_NOW only) is booked by ONE entry, `sourceKind = walk_in_sale`,
  `sourceId = invoice id`: `Dr tender accounts / Cr REVENUE.SALES (total − tax) / Cr LIABILITY.TAX_PAYABLE (tax)`
  (`sales/walk-in-sale-journal.ts`, net-of-discount convention `3b.9-ACC`).
- After the invoice is issued, `order.repository.ts` refuses cancellation with `WALKIN_POST_INVOICE_CANCELLATION_NOT_AVAILABLE`.
  The 3b.8 path needs a customer: a CreditNote funds a `CustomerAdvance` on a customer account, then a Refund pays that advance.
- Result: an anonymous customer who paid cash and returns the goods **cannot be refunded in the system**, and the tax already
  declared in `LIABILITY.TAX_PAYABLE` cannot be reversed. In production that forces off-system cash handouts or direct journal
  edits (both are prohibited: the GL is append-only and Z-reports are immutable).

## 2. Requirements any solution must meet

1. Reversal is a **new** balanced entry (rule 16), never an edit; keyed by a unique `source_kind + source_id` so a retry is a no-op.
2. Revenue/tax reversed at the **original** net amounts; tender refunded from the **original tender accounts** (cash, bank,
   payment clearing). A refund can never exceed what was received, in total or per tender.
3. A tax-correct document: in the GCC a tax invoice is corrected by a **credit note** (KSA/ZATCA requires it; UAE requires a tax
   credit note). A bare journal reversal with no document is not acceptable for a tax-registered tenant.
4. Authority: step-up MFA, an existing permission, audit row in the same transaction, `acting_user_id` never overwritten
   (rules 12–13). Idempotency-Key mandatory.
5. Online-only (rule 31). Same-transaction GL (rule 18). No change to any posted entry, invoice figure or Z-report.
6. Cash refunds interact with the **cash drawer** — Phase 4 (cash register) owns drawer movements, Z-reports and over/short.
   Until Phase 4 exists, a cash refund must be recorded so Phase 4 can reconcile it (no silent drawer effect).

## 3. Options

|                     | A. Anonymous credit note + direct tender refund (**recommended**)                                                                                                                                                                                                     | B. Journal-only void (no document)                 | C. Keep blocking, forbid anonymous sales in production                        |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- | ----------------------------------------------------------------------------- |
| Mechanism           | New credit-note kind for an anonymous invoice (`customer_id` NULL), full-invoice only in v1, with refund lines per original tender; one entry `Dr REVENUE.SALES, Dr TAX_PAYABLE / Cr tender accounts` (`sourceKind = walk_in_sale_reversal`, `sourceId = invoice id`) | Same entry, no credit-note row                     | Production flag keeps `POST …/sales` anonymous path disabled until A is built |
| Tax document        | Yes — credit note, numbered from the company counter                                                                                                                                                                                                                  | **No** — fails requirement 3                       | n/a                                                                           |
| Touches frozen 3b.8 | **Yes** — nullable customer on `credit_note`, new coverage rules, new migration (51+ in the Phase 3 numbering)                                                                                                                                                        | No frozen table change, but a new posting template | No financial change                                                           |
| Risk                | Highest effort; must re-prove 3b.8 chains                                                                                                                                                                                                                             | Compliance gap; likely rework                      | Business cannot sell to walk-in customers in production                       |

**Recommendation:** A for the release, and C as the interim control until A is accepted (it is the only option that is safe today).

## 4. Proposed design for A (for the owner to amend)

- **Scope v1:** full reversal of one ISSUED, fully paid anonymous invoice, same company/branch; partial returns, exchanges and
  multi-day windows are out of scope (a v2 decision).
- **Route:** `POST /v1/companies/:companyId/branches/:branchId/invoices/:invoiceId/anonymous-void` — `refunds:execute` (already
  step-up gated) **plus** the branch scope of the original sale; no new permission key. Body: `{ reason, refundTenders? }` where
  `refundTenders` may only re-state the original tender split (default: exactly the original split).
- **Effects, one transaction, one outbox event:** (1) lock the invoice; (2) assert not already reversed (unique source);
  (3) allocate the credit-note number; (4) insert the anonymous credit note + refund lines; (5) post the single reversal entry;
  (6) mark the invoice `REFUNDED` (existing state); (7) audit `orders.anonymous_sale_voided`; (8) for CASH, write a
  **refund-pending-drawer** marker row that Phase 4 consumes (no drawer posting before Phase 4).
- **Period rules:** posted on the current open period using the company-timezone date (frozen `HG3b-POSTING-DATE`); never into a
  CLOSED period; the original entry is untouched.
- **Never allowed:** a refund to a tender the customer did not use; a second reversal; a reversal of a sale with a provider-backed
  tender (those need the provider-refund path — already a side-effect-free 501 in 3b.8).

## 5. Acceptance tests (to be written with the implementation)

Real PostgreSQL: exact reversal for each tender mix incl. 3-decimal currencies; tax-inclusive and exclusive; net-of-discount;
per-tender cap; double void / concurrent void → exactly one (`FOR UPDATE` + unique source); retry with the same Idempotency-Key;
closed period; cross-tenant / cross-branch denial; step-up and permission denial; Manager/Cashier matrix as decided; the original
`walk_in_sale` entry byte-identical afterwards; GL balanced and Σ(revenue, tax) returns to the pre-sale figures; audit/outbox
co-committed; HG3b-PCI canaries on the new route; every 3b.8 hash pin updated only through an explicit authorised-change entry.

## 6. Owner decisions needed

1. Approve option A (and the migration that makes `credit_note.customer_id` nullable) or choose B / C.
2. Confirm full-reversal-only for v1 and the same-day vs any-day window.
3. Confirm no new permission key (reuse `refunds:execute`) and who may use it.
4. Approve the interim control C (production flag disabling anonymous sales) and where it lives.
5. Approve reopening the frozen 3b.8 surface for exactly the listed additive change.

---

## 7. Decision review (second pass, 2026-11-11) — still NOT approved, nothing implemented

### 7.1 What the frozen 3b.8 path actually does (verified in `credit-note.repository.ts`, `refund-*.repository.ts`)

For a customer-linked invoice, a credit note posts ONE entry (`sourceKind = credit_note`, `sourceId = credit note id`):

| Line                             | Amount                                                                       |
| -------------------------------- | ---------------------------------------------------------------------------- |
| Dr `REVENUE.SALES`               | credit total − tax                                                           |
| Dr `LIABILITY.TAX_PAYABLE`       | tax                                                                          |
| Cr `ASSET.ACCOUNTS_RECEIVABLE`   | the part that reduces what the customer still owes                           |
| Cr `LIABILITY.CUSTOMER_ADVANCES` | the excess (money the customer already paid), held on the customer's account |

A cash/bank refund is then a SECOND, separate action (`sourceKind = refund`): `Dr LIABILITY.CUSTOMER_ADVANCES / Cr <tender account>`
(a provider payout goes via `ASSET.PAYMENT_CLEARING`; provider refunds are a side-effect-free 501 in 3b.8). For a fully paid ANONYMOUS
sale the AR part is 0 and the whole credit would have to sit in `CUSTOMER_ADVANCES` — which needs a customer account that does not exist.
That, and nothing else, is the gap.

### 7.2 Real POS requirements the choice must serve

1. **Void (same shift, customer still at the counter):** cancel the sale and give the money back at once. Must be one fast action.
2. **Return with receipt (later day):** refund to the original tender, correct the tax declared.
3. **Return without receipt / goodwill:** out of scope (needs a policy: store credit, manager approval).
4. **Exchange / partial return:** a v2 concern; a full reversal plus a new sale covers it in v1.
5. **Tax compliance:** a tax invoice already issued is corrected by a numbered credit note (UAE tax credit note; ZATCA credit note for KSA).
6. **Cash control:** a cash refund reduces the drawer; Phase 4 owns drawer movements, Z-reports and over/short.

### 7.3 Options compared

| Criterion              | A — anonymous credit note + direct tender refund                                                                               | B — journal-only reversal | C — block anonymous sales          | D — identified "walk-in" customer (no new financial code)                                                                                                                                          |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------- | ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Accounting             | one balanced entry; revenue/tax reversed at the original net amounts; tender returned in the same entry (no advance liability) | same entry, no document   | none                               | 3b.8 path unchanged: credit note → advance on the walk-in account → refund = two entries                                                                                                           |
| Tax document           | credit note, gapless number                                                                                                    | **none — non-compliant**  | n/a                                | credit note (customer = the generic walk-in account)                                                                                                                                               |
| Void (use case 1)      | one action                                                                                                                     | one action                | not possible (no sales)            | two actions (credit note, then refund); can be one UI step but two postings                                                                                                                        |
| Refund (use case 2)    | exact original-tender refund, capped per tender                                                                                | same, no document         | n/a                                | refund from the advance balance: the **advance is commingled on one shared account**, so a second cashier could refund against another sale's credit unless refunds are tied to the credit note id |
| Auditability           | per-invoice 1:1 reversal; unique `source_kind+source_id` makes a retry a no-op                                                 | weaker (no document)      | n/a                                | per-credit-note, but customer reports show a standing "walk-in" advance balance until refunded                                                                                                     |
| Frozen-contract impact | **reopens 3b.8 additively** (nullable customer on `credit_note`, new coverage rule, a migration)                               | new posting template only | none                               | **none** — but it uses the identified-customer sale path (already built, Checkpoint D)                                                                                                             |
| Operational impact     | none for cashiers                                                                                                              | none                      | walk-in customers cannot be served | cashier selects the generic walk-in customer on every sale (one tap)                                                                                                                               |

### 7.4 Exact effects of the recommended option A (worked example)

Sale AED 105.00 (net 100.00 + 5% VAT 5.00), paid AED 60.00 cash + AED 45.00 manual card terminal. Original entry (frozen):
`Dr ASSET.CASH_ON_HAND 6000 · Dr ASSET.PAYMENT_CLEARING 4500 / Cr REVENUE.SALES 10000 · Cr LIABILITY.TAX_PAYABLE 500` (minor units).

Full reversal (one new entry, `sourceKind = walk_in_sale_reversal`, `sourceId = invoice id`, one per invoice):
`Dr REVENUE.SALES 10000 · Dr LIABILITY.TAX_PAYABLE 500 / Cr ASSET.CASH_ON_HAND 6000 · Cr ASSET.PAYMENT_CLEARING 4500`.

- **Credit note:** a new numbered document for invoice N (anonymous, no customer), total 10500, tax 500; one refund line per original tender (6000 cash, 4500 card). The invoice becomes `REFUNDED` (existing state).
- **Tender refund:** each line may not exceed what that tender received; the refund tender defaults to the original split. Cash is recorded as a **refund-pending-drawer** marker for Phase 4; no drawer posting exists before Phase 4. The card-terminal part is returned through the terminal; `ASSET.PAYMENT_CLEARING` is credited exactly as the sale debited it.
- **GL/period:** posted on the current OPEN period in the company-timezone date (`HG3b-POSTING-DATE`); the original entry, invoice, Z-report and prior period are untouched. Σ(revenue, tax) returns to the pre-sale figures.
- **Not allowed:** a second reversal; a refund above the received amount or to a tender not used; a reversal of a provider-backed sale (provider refunds stay 501); a CLOSED period.

### 7.5 Interim restriction until RB-1 is approved and built

Option C as written (disable anonymous sales) blocks ordinary walk-in trade, which is more than needed. The narrowest safe restriction is
**"no ANONYMOUS issued sales in production; identified sales stay open"** — option D as an operational stop-gap:

- The tenant creates ONE generic customer per company ("Walk-in customer", no credit limit, `PAY_NOW` only). Cashiers pick it for every
  over-the-counter sale (one tap). Every sale then follows the already-built, already-verified identified-customer path, so
  void/return works through the frozen 3b.8 credit-note and refund path with **no new financial code**.
- A production switch (per tenant, default OFF in production) makes `POST …/orders/:orderId/complete-sale` reject an order whose customer is
  null. It is a small change in the frozen `sales` module and needs your approval; it can ship as configuration of the existing capability
  mechanism or as a one-line guard — the exact location is part of the decision.
- **Known cost of D:** the generic customer carries a standing `CUSTOMER_ADVANCES` balance between credit note and refund, and the
  customer reports/statements for that account are noisy. Mitigation: refund in the same action as the credit note, and have a daily
  report of the generic customer's advance balance (must be 0 at close). This is a stop-gap, not the final design (A).

### 7.6 Recommendation and decision requested

Build **A** (full-reversal-only v1) as the release solution; adopt **D** as the interim operating rule until A is accepted; do **not** choose B
(no tax document). **Approve, amend or reject, in this order:** (1) A vs D-only vs C; (2) the migration making `credit_note.customer_id`
nullable and the reopened additive 3b.8 surface; (3) full-reversal-only v1 and any time window; (4) reuse of `refunds:execute` (no new
permission); (5) where the interim production switch lives. No financial code will be written before this decision.

---

## 8. Contract verification and the FINAL recommended financial contract (supersedes the migration claim in §3, §4 and §7)

**Correction.** Sections 3–7 proposed "making `credit_note.customer_id` nullable". Verified against the code and schema: **`credit_note` has
no `customerId` column** (it hangs off `invoiceId`). The customer dependence of the frozen 3b.8 path is only: (a) the CHECK
`credit_note_split_eq_total_chk` (`arReductionMinor + advanceExcessMinor = totalAmountMinor`, migration `20261005120000`); (b) the
`CustomerAdvance` and `CustomerAccountEntry` a credit note creates; (c) the application guard
`WALKIN_POST_INVOICE_CANCELLATION_NOT_AVAILABLE` in `OrderRepository.cancelForBranchScoped` (pinned by a test). Extending `credit_note`
for anonymous sales would therefore mean replacing a frozen CHECK and its triggers — the opposite of narrow.

### 8.1 Verified existing contracts the design must reuse (with their source)

| Contract              | Verified fact                                                                                                                                                                                                         | Source                                                            |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Credit-note numbering | company-scoped, gapless, `CN-000001`, its own counter row `document_number_counter.documentType = 'CREDIT_NOTE'` (already in the CHECK)                                                                               | `schema.prisma` `CreditNote`, migration `20261005120000` line 106 |
| Partial credits       | a credit note is line-based: `CreditNoteLine.quantityCredited`, cumulative `SUM ≤ OrderLine.quantity` enforced by a capacity trigger; tax per line proportional to the frozen line snapshot, never current tax config | `schema.prisma` `CreditNoteLine`                                  |
| Journal convention    | net-of-discount: `Dr REVENUE.SALES (total − tax) / Dr LIABILITY.TAX_PAYABLE`, one entry per document, `sourceKind + sourceId` unique, posting date in the company timezone                                            | `credit-note.repository.ts`, `walk-in-sale-journal.ts`            |
| Tender → account      | CASH → `ASSET.CASH_ON_HAND`; BANK_TRANSFER → `ASSET.BANK`; manual CARD_TERMINAL / OTHER_MANUAL → `ASSET.PAYMENT_CLEARING`; provider-backed or unknown tender fails closed                                             | `tender-account-mapping.ts`                                       |
| Provider tenders      | cannot reach an atomic (anonymous) sale; a provider refund is a side-effect-free `501` in 3b.8                                                                                                                        | `walk-in-sale-journal.ts`, 3b.8                                   |
| Authority             | `credit_notes:issue` and `refunds:execute` are step-up-gated and held only by owner, admin, manager and accountant — **a Cashier cannot issue or refund**; the existing refund route is `@Idempotent({ scope })`      | `system-roles.ts`, `refund.controller.ts`                         |
| Idempotency           | refunds use a mandatory `Idempotency-Key`; the cancel route uses `If-Match` on the order version                                                                                                                      | `refund.controller.ts`, `order.controller.ts`                     |
| Invoice statuses      | `REFUNDED` and `PARTIALLY_REFUNDED` already exist and block a second cancellation                                                                                                                                     | `order.repository.ts` `INVOICE_CANCELLATION_BLOCKED_STATUSES`     |
| Frozen guard          | an anonymous issued sale is refused with `422 WALKIN_POST_INVOICE_CANCELLATION_NOT_AVAILABLE`; a test pins it                                                                                                         | `order.repository.ts`                                             |

### 8.2 FINAL recommended contract — option A2 "additive anonymous credit note" (proposed, NOT approved)

**Principle:** do not edit any frozen table, CHECK, trigger, guard or posting. Add a parallel, additive document for ANONYMOUS invoices only.

1. **Schema (one new additive migration, no change to any existing object):** `anonymous_credit_note` (tenant/company/branch, `invoiceId` via the same composite FK shape, `creditNoteNumber` from the SAME `CREDIT_NOTE` company counter so the series stays gapless across both kinds, `issuedAt`, `accountingDate`, currency, `reasonCode` from the same closed vocabulary, `note`, subtotal / tax / total, `createdByUserId`); `anonymous_credit_note_line` (orderLineId, `quantityCredited`, the same proportional components, capacity trigger `SUM(quantityCredited) ≤ OrderLine.quantity`); `anonymous_credit_note_refund` (method, `amountMinor`, optional `reference` ≤ 60 chars). RLS on all three; immutable after insert; a deferred trigger proves `SUM(lines) = totals` and `SUM(refunds) = total`; a per-tender trigger proves, per invoice, `SUM(refund by method) ≤ SUM(payment by method)` (the source is the sale's own `payment` rows: `method`, `amountMinor`).
2. **Guard rule:** the new route accepts ONLY an invoice whose order has `customerId IS NULL`; the frozen guard and its pin stay exactly as they are, so a customer-linked invoice can never use this path and an anonymous one can never use the 3b.8 path.
3. **Route:** `POST /v1/companies/:companyId/branches/:branchId/invoices/:invoiceId/anonymous-credit-notes`; permissions `credit_notes:issue` AND `refunds:execute` (the existing additive multi-permission mechanism), step-up on both; mandatory `Idempotency-Key`; body `{ reasonCode, note?, lines: [{ orderLineId, quantity }], refunds: [{ method, amountMinor, reference? }] }`. A full reversal lists every line at full quantity. Body free text goes through the F3 card guard.
4. **One transaction, one outbox event:** lock order invoice → order lines → company document counter (the established order); compute lines from the frozen snapshot; allocate the number; insert note + lines + refunds; post ONE journal `sourceKind = anonymous_credit_note`, `sourceId = note id`: `Dr REVENUE.SALES (total − tax) · Dr LIABILITY.TAX_PAYABLE (tax) / Cr <tender account per refund line>`; set the invoice `REFUNDED` (all lines fully credited) or `PARTIALLY_REFUNDED`; audit `credit_note.issued` with `anonymous: true` (bounded payload, no PII, no card data); outbox `orders.anonymous_credit_note_issued`.
5. **VAT:** each line's tax credit equals the sale's own frozen per-line tax, so the sum of all credit notes on an invoice can never exceed the tax declared; the reversal reduces `LIABILITY.TAX_PAYABLE` exactly by what the sale credited.
6. **Refund ownership and tender constraints:** the actor is the authenticated user with both permissions (a manager/accountant/admin/owner; a Cashier needs a manager at the counter) and is stored in `createdByUserId`, never overwritten; every refund line's method must be one the sale was paid with, within `paid − already refunded` for that method (so a card payment can never be refunded as cash); the refund total must equal the credit total exactly; no overpayment, no cash rounding (OD-9).
7. **Idempotency and duplicates:** same `Idempotency-Key` → the stored response is replayed; a different key for the same lines → rejected by the line-capacity trigger once the quantity is exhausted (a full reversal cannot happen twice); concurrent submissions serialise on the invoice lock and the counter lock.
8. **Failure handling:** every failure rolls the whole transaction back (no number consumed, no journal, no refund row). **Manual card-terminal refunds are attested, not executed:** the system records that the cashier refunded on the terminal; if the terminal refund fails the user must not submit (or must correct the request) — nothing is half-recorded. A wrongly attested terminal refund surfaces as a difference in `ASSET.PAYMENT_CLEARING` at settlement reconciliation (3b.7). Provider-backed refunds do not exist for anonymous sales.
9. **Voids:** a void is a full anonymous credit note with an existing `reasonCode` (e.g. `CUSTOMER_REQUEST`, `ORDER_ERROR`); there is no second mechanism.
10. **Cross-phase dependency (stated, not designed here):** a CASH refund credits `ASSET.CASH_ON_HAND` in Phase 3; Phase 4 (cash register) must treat anonymous-credit-note cash refunds as drawer payouts when it exists. Without that hook the drawer count would show a surplus equal to the refunds.

### 8.3 Partial refunds, mixed tenders, failed refunds, voids, duplicates — scenario outcomes under A2

| Scenario                                               | Outcome                                                                                                                                                |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Full reversal, single tender                           | one note, one journal, refund line = total, invoice `REFUNDED`                                                                                         |
| Full reversal, mixed tenders (60 cash + 45 terminal)   | refund lines may be 60 cash + 45 terminal; a 105 cash refund is rejected (cash cap 60)                                                                 |
| Partial return (one line, part of quantity)            | note for that quantity; tax/net proportional from the frozen line; invoice `PARTIALLY_REFUNDED`; a second note may follow until each line is exhausted |
| Refund exceeds what the tender paid / mismatches total | whole request rejected, nothing written                                                                                                                |
| Terminal refund failed physically                      | cashier does not submit; if already submitted wrongly, correction is a reconciliation item, not a silent edit                                          |
| Duplicate request, same key                            | identical stored response replayed                                                                                                                     |
| Duplicate request, new key, same lines                 | rejected by the capacity trigger                                                                                                                       |
| Customer-linked invoice sent to this route             | rejected (guard rule 2); 3b.8 path unchanged                                                                                                           |
| Closed period                                          | posting refused, nothing written (frozen `HG3b-PERIOD-INTEGRITY`)                                                                                      |

### 8.4 The generic "Walk-in customer" interim (option D) — risk assessment

Works with no financial code because it uses the identified-customer sale (Checkpoint D) and the frozen credit-note + refund path.
**Risks:** (1) **commingled liability** — every return parks money in `LIABILITY.CUSTOMER_ADVANCES` on one shared account until refunded; a second
cashier/manager could spend or refund against another sale's credit unless every refund is tied to its credit note and done in the same
action; (2) **reconciliation noise** — the customer-liabilities and receivables reports show a standing balance for that customer; the control
is a daily check that the balance is zero at close; (3) **audit weakness** — the ledger shows a customer advance, not a refund of a specific
anonymous sale, and the customer identity carries no information; (4) **credit abuse** — the generic customer must have credit disabled and
`PAY_NOW` only, or a cashier could sell on credit to an unaccountable account; (5) **customer statements/loyalty** are meaningless for it.
It is acceptable only as a short, supervised stop-gap, never as the release solution.

### 8.5 Narrowest frozen-contract amendment and the exact approval it needs

**A2 requires no edit to a frozen table, CHECK, trigger, guard, posting template or pinned file.** It requires:

- **One additive migration** (three new tables + their triggers/RLS/grants). It follows the Phase 3 migration sequence; the Phase 4 branch's migrations 50–53 carry later timestamps, but their structural pins count migration rows (for example "52 earlier rows"), so merging the two branches needs those counts reconciled — a Phase 4 task, flagged now.
- **One new route + service + module** in a new file set, registered through a module that is not content-hash-pinned.
- **S0-style authorisation entries** only for the new migration's content hash if the Phase 3 hash pins list migrations (to be confirmed at implementation time).
- **No new permission key** (reuses `credit_notes:issue` + `refunds:execute`).

**Exact owner approval requested** (nothing is implemented until given): (1) approve **A2** as the release solution (full AND partial credits in v1, per-tender caps as in 8.2 rule 6); (2) approve the one additive migration and the new route; (3) confirm that cashiers cannot self-refund (manager/accountant/admin/owner only), or approve a new narrower permission instead; (4) confirm the order becomes `CANCELLED` on a full reversal, mirroring 3b.8, or that it stays as is; (5) approve the CASH-refund / Phase 4 drawer dependency; (6) approve D only as a time-boxed interim and state who enforces the daily zero-balance check; (7) approve where the interim production restriction lives. **No production restriction and no financial policy is activated by this document.**

---

## 9. IMPLEMENTATION RECORD (2026-11-11, owner decisions 1–7 applied) — what was built, and where it differs from §8

**Status: implemented and verified locally on branch `phase-3/3b-closure-hardening`; uncommitted; NOT merged; NOT deployed. No production
restriction and no financial policy is activated by it.** Nothing in this record changes an existing financial contract.

### 9.1 Owner decisions → implementation

| Owner decision                                                                                                     | Implementation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1. A2, subject to verifying the invariants against the frozen accounting contracts                                 | Journals use ONLY existing account keys and the frozen posting engine, net-of-discount convention, frozen tender → account mapping, frozen `CREDIT_NOTE` counter; every invariant is proven by tests (§9.4)                                                                                                                                                                                                                                                                                                  |
| 2. Cashiers must not issue or execute refunds; keep the existing permissions                                       | Route key `credit_notes:issue`; the service additionally requires `refunds:execute` (with step-up) through the same `PolicyEngine`, before any work; execute / fail need `refunds:execute`; reads need `credit_notes:view`. **No new permission key.** A cashier is refused on every route (tested)                                                                                                                                                                                                          |
| 3. Immutable credit notes and reversal journals; no mutation of the original journal or **order status**           | Notes and lines are immutable (trigger); the original invoice, order, order lines, payments and sale journal are **byte-identical** after a credit (tested by a row-level fingerprint). **The order is NOT set to CANCELLED and the invoice status is NOT changed** — a reversed sale is identified by `invoiceReversal` (NONE / PARTIAL / FULL) derived from the credit records. Whether a fully reversed order should become `CANCELLED` stays a separate decision                                         |
| 4. Cash movement and accounting consistent; never report a refund executed before verified; no Phase 4 integration | A refund line is created **PENDING** and becomes **EXECUTED only when an authorised user attests** the tender execution (`…/execute`, optional receipt reference) or **FAILED** (`…/fail`, closed reason list). The issuance journal books the refund **in flight** on `ASSET.PAYMENT_CLEARING` (the frozen 3b.8 in-flight account); only the attested execution moves cash / bank out (`Dr PAYMENT_CLEARING / Cr CASH_ON_HAND or BANK`). **No cash-drawer or Phase 4 hook exists or is invented** — see 9.5 |
| 5. Walk-in-customer workaround not permanent; no production-wide restriction                                       | Not implemented, not activated, no flag added                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 6. F3 retained                                                                                                     | Free-text `note` passes the global card-number guard (tested on this route)                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 7. P6f, userId fixture, `InputHardeningModule`, frozen hashes preserved                                            | Unchanged; the frozen-file audit in the evidence document re-verifies them                                                                                                                                                                                                                                                                                                                                                                                                                                   |

### 9.2 Differences from the §8 design (deliberate, owner decisions applied)

1. **No order / invoice status change** (owner decision 3). §8 proposed marking the invoice `REFUNDED` / `PARTIALLY_REFUNDED`; the build leaves both untouched.
2. **Two-phase accounting** instead of crediting cash at issuance (owner decision 4): issuance `Dr REVENUE.SALES (total − tax) · Dr LIABILITY.TAX_PAYABLE / Cr ASSET.PAYMENT_CLEARING (total)`; execution of a cash / bank line `Dr ASSET.PAYMENT_CLEARING / Cr ASSET.CASH_ON_HAND | ASSET.BANK`; execution of a manual card / other line posts **nothing** (the sale itself debited `PAYMENT_CLEARING`, so the issuance credit is already the final effect); a FAILED line posts nothing.
3. **Composite authority in the service** (not `@RequireAllPermissions`, which a frozen pin reserves for the report controllers) — the same pattern the frozen 3b.8 cancel path uses.
4. **Five routes** (no list route): issue, get, add a (replacement) refund line, execute (attest), fail (attest).

### 9.3 Exact amendments to frozen artefacts (all additive and minimal; nothing frozen relaxed)

| Artefact                                                                                            | Amendment                                                                                                                                                                                                                                                                                                                | Why it is safe                                                                                                    |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| Migration `20261105120000_phase_3b_rb1_anonymous_credit_note`                                       | NEW (three tables, triggers, RLS, least-privilege grants); no existing object altered                                                                                                                                                                                                                                    | additive-only SQL, proven statement by statement by a structural test; content hash pinned                        |
| `schema.prisma`                                                                                     | a marked, hash-pinned block appended at the end (three scalar-only models, no relation field)                                                                                                                                                                                                                            | the frozen part, with the block removed, still hashes to the frozen `15ef99ce…`                                   |
| 11 frozen structural pins (`task-3b9-checkpoint-b…f`, `task-3b10-checkpoint-a…f`)                   | migration listings go through `withoutAuthorizedMigrations(...)`, the schema hash through `frozenSchemaShaOfFile(...)`; **every frozen expected value is unchanged**                                                                                                                                                     | the 49 frozen migrations and the frozen schema are still proven byte-identical; the addition is pinned separately |
| `task-3b10-checkpoint-d` / `-e` "closed set of journal producers"                                   | the new repository is added to the reviewed list with the review recorded (it posts no AR / customer-liability account)                                                                                                                                                                                                  | the closed-set property is kept; an unreviewed producer still fails                                               |
| Orders integration pin **N8** (3b.8 public route surface: "no credit-note / refund route anywhere") | frozen `expected` list untouched; the five reviewed `AnonymousCreditNoteController` rows (permission, step-up, scope) are asserted as an exact closed set; every OTHER route must still satisfy the frozen "nothing else" rules. Found by the final regression — it failed once, correctly, because the routes now exist | still fails on any unreviewed credit-note / refund route; only the five reviewed ones are exempt                  |
| `common/audit/actions.ts`                                                                           | four registered actions `anonymous_credit_note.issued / refund_added / refund_executed / refund_failed`                                                                                                                                                                                                                  | registered, `security: false`, bounded payloads                                                                   |
| `settlements.module.ts`                                                                             | imports the new module (the only unpinned host: `app.module.ts` and the sales / order / payment / receivables modules are byte-locked)                                                                                                                                                                                   | one import line                                                                                                   |
| `cross-tenant.probe.test.ts`                                                                        | probed-prefix entry pointing at the isolation test                                                                                                                                                                                                                                                                       | same precedent as the reporting routes                                                                            |
| New helper `verification/phase3b-authorized-additions.ts`                                           | the Phase 3B-only mechanism (Phase 4 keeps its own `frozen-baseline.ts` on its branch; they are reconciled when the branches merge)                                                                                                                                                                                      | pins the migration and the block by content hash                                                                  |

### 9.4 Financial invariants verified (real PostgreSQL, full HTTP stack)

Exact journal for a taxed sale (revenue, tax, in-flight clearing) and that the original sale is byte-identical afterwards; execution of a cash refund
(net effect: revenue and tax reversed, cash out, clearing back to its prior balance); mixed tenders (a card payment can never be refunded as cash, a
tender that was not used has a cap of 0, lines must sum to the credit total, manual card execution posts nothing, every journal of the feature balances);
partial credits 1 + 1 + final 1 of 3 summing **exactly** to the invoice including VAT, checked against an independent oracle built from the frozen line;
document discounts; a failed refund posts nothing and leaves its amount unallocated, replacement lines respect the tender caps and the credit total,
EXECUTED / FAILED are terminal; idempotent replay with the same key and rejection of an exhausted credit with a new key; six simultaneous full credits →
exactly one; racing partials never exceed the quantity; five racing replacement refunds → exactly one; customer-linked invoices refused; cashier /
issue-only / no-step-up callers refused on every route; tenant, company and branch isolation (non-disclosing 404, nothing written); database guards
against a direct writer (immutability, guarded refund transitions, anonymous-only, tender caps, line capacity); a closed accounting period rolls the whole
transaction back including the number allocation. Pure plan: a 300-trial property test (any partial sequence ending in the final credit sums to the
frozen line exactly) and an equivalence test against the frozen 3b.8 full-credit derivation.

### 9.5 What is NOT done and why (owner decisions or later phases)

1. **Cash drawer / Phase 4:** a cash refund credits `ASSET.CASH_ON_HAND` when attested. Phase 4's cash register must treat that attestation as a drawer payout; no hook exists, none was invented. Until Phase 4, drawer reconciliation of anonymous cash refunds is manual.
2. **Order `CANCELLED` on a full reversal:** not done (owner decision 3); a separate verified contract decision.
3. **Provider-backed refunds** do not exist for anonymous sales (provider tenders cannot reach an anonymous sale); the frozen provider-refund path remains a side-effect-free 501.
4. **`PAYMENT_CLEARING` semantics:** the build reuses the frozen in-flight account for pending refunds (3b.8's own precedent). An accountant should confirm that a pending cash refund on `PAYMENT_CLEARING` is the desired presentation before release; the alternative (a dedicated "refunds payable" account) needs a chart-of-accounts change and was not made.
5. **Realtime / outbox events:** none emitted (audit only), to avoid touching the frozen event vocabulary; add if the product needs live updates.
6. **Migration numbering with Phase 4:** this migration carries the timestamp `20261105…`; Phase 4's migrations 50–53 (`20261201…`) sort after it, but their pins count migration rows and must be reconciled when the branches merge.

### 9.6 Final financial audit (2026-11-11, second pass) — pointer

An independent re-read of the journals and the refund lifecycle, plus three new tests whose expectations come from the journal tables and the frozen
reports (a **ledger oracle** across pending / partially executed / failed / replaced / executed, a **report-impact** test, and the executed
**control queries** of `RB-1-ACCOUNTANT-CONTROL-QUERIES.sql`), is recorded in `PHASE-3B-CLOSURE-EVIDENCE.md` §2. Findings F-1…F-10 are **reported, not
fixed**; the notable ones: the frozen Sales and Tender Totals reports do not include anonymous credits (F-1, F-2); `PAYMENT_CLEARING` carries a credit
balance while refunds are in flight (F-3); the database does not couple `EXECUTED` to its journal, so the reconciliation query is the detective control
(F-4). **Correction:** §9.3 said 14 frozen structural pins; the correct count is **11 structural pins plus the N8 route pin = 12 pin amendments**.

### 9.7 Financial closure round (2026-11-12) — what changed after §9.6

- **F-4 fixed.** Migration `20261105120000` (never applied or pushed) gained two **deferred commit-time guards** — a refund can become `EXECUTED` only with
  exactly one sealed execution journal of the exact shape (cash / bank), and a manual-card / failed / pending refund must have none; a credit note cannot
  commit without its exact issuance journal — and a **read-only platform grant**. The migration's pinned hash was **re-pinned** (`52693cf2…ab1c` →
  `d12edf2b…b242`). The guards enforce the existing two-phase policy; they introduce no new accounting policy. A superuser can still disable triggers; the
  reconciliation (Q3 and the summary) is the detective control for that residual path.
- **F-1 / F-2 mitigated.** A read-only **anonymous credit-note summary** (two routes under `credit_notes:view`, no new permission) reports the new journal
  kinds, issued / pending / executed / failed refunds, the adjustments to subtract from the frozen Sales and Tender Totals reports, and a ledger
  reconciliation that is `false` whenever a figure disagrees with the ledger. **The frozen reports are unchanged**; the exact amendment that would fold the
  summary into them is in `R-1-REPORTING-AMENDMENT-SPEC.md`, **for owner approval**.
- **One time source.** The repository now writes `issuedAt`, `createdAt`, `resolvedAt` and `updatedAt` from the application's accounting clock (the instant
  that also derives the journal's posting date) instead of the database clock; no amount or policy changed.
- **Route count.** There are now seven routes: the five of §9.2 plus the two read-only summary routes.
- Control queries gained **Q7** (refunds attested by the user who issued the credit note).
