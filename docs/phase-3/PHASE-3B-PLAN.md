# PHASE-3B-PLAN.md — Phase 3b implementation plan (revenue + financial truth)

> Governing predecessor: [`PHASE-3-PLAN.md`](PHASE-3-PLAN.md) §0.2 D2-1 ("`Phase
3a` = generic catalog / UOM / identifiers / pricing / tax-reference foundation.
> `Phase 3b` = orders / payments / GL / receivables / settlement / cancellation /
> refund / atomic walk-in sale.") and §H.3 (the non-scheduled task outline this
> plan now schedules in full). Phase 3a shipped and is frozen —
> [`PHASE-3A-RESULTS.md`](PHASE-3A-RESULTS.md), tag `phase-3a-catalog-complete`.
> Authoritative financial design: [`ADR-0019`](../decisions/ADR-0019.md)
> (customer receivables/settlement/cancellation/refund — treated as **frozen
> behavior** by this plan, not redesigned). Provider-port discipline:
> [`ADR-0007`](../decisions/ADR-0007.md). No-runtime-discriminator discipline:
> [`ADR-0018`](../decisions/ADR-0018.md), extended here unchanged.

---

## 0. Locked decisions

### 0.1 Carried from Phase 3a / ADR-0019 / ADR-0007 (preserve exactly)

- **Phase split (D2-1).** `phase-3-complete` may only be created after **both**
  Phase 3a and Phase 3b's exit criteria are satisfied. `phase-3a-catalog-complete`
  was an intermediate checkpoint only.
- **ADR-0019 is frozen behavior for this plan.** In particular, and without
  limitation: a `PAYMENT` entry is never the same event as a
  `PAYMENT_ALLOCATION` (§8); `invoice_payment_status` distinguishes `PAID` from
  `SETTLED` and the two are never interchangeable (§2); a `settlement` header
  carries no independent balance-affecting value (§9); default settlement
  allocation is deterministic **AUTO FIFO**, manual-allocation and
  settlement-discount both default **OFF** (§3–§5); the customer subledger is
  append-only, corrections are `REVERSAL` entries, never edits (§10, §12);
  cancellation/refund resolution is computed only against **actual money
  received**, never the nominal total (§19); Account Credit is an `ADVANCE`
  variant, never a parallel balance or a fabricated `REFUND` (§19, §31); a
  cancellation charge is a first-class, reversible, auditable concept (§21–§24);
  Credit is **not** a payment method (§1).
- **ADR-0007 `PaymentProvider` port is frozen and vendor-neutral**
  (`createIntent·authorize·capture·refund·getStatus·verifyWebhook`). Vendor
  selection for Phase 3b is made in §0.2 below; the port itself is unchanged.
- **ADR-0018's no-runtime-discriminator discipline extends unchanged to Phase
  3b** — no `if (businessTypeKey === …)` branch anywhere in the revenue path;
  the `catalog-no-bt-branch` structural gate is extended to every new Phase 3b
  domain file (HG3b-NO-BT-BRANCH, §G).
- **One GL per Company** (ZF-3) — never per-tenant, never per-branch; branch /
  POS terminal / shift are journal-line **dimensions**, never a second ledger.
- **RLS `ENABLE`+`FORCE`** on every tenant-owned Phase 3b table, tenant-id
  policy, `flower_app` non-superuser role — identical posture to every Phase 3a
  table. **A POS terminal id remains identity/origin/attribution only, never an
  isolation axis**, on every Phase 3b table exactly as already frozen for
  catalog/POS in CLAUDE.md rule 8.

### 0.2 Amendments locked for Phase 3b (this plan)

- **D3b-1 — Terminology.** The product/requirements/documentation/UI term for a
  sale resolved across more than one financial component is **"Multi Payment"**.
  "Mixed Payment" / "Mixed Tender" are **never** used. Internal technical names
  (`payment`, `payment_attempt`, `payment_allocation`) are unaffected.
- **D3b-2 — Stable Chart-of-Accounts keys.** The posting engine addresses
  accounts by an immutable internal `key` (§C.1); `display_code`/`display_name`
  are company-editable, `key` is not. No Inventory / COGS / Purchase / Accounts
  Payable account exists in Phase 3b's CoA — those arrive with Phase 5.
- **D3b-3 — DB-level balanced-journal backstop.** Application-level balance
  checking alone is insufficient; an unbalanced posted journal entry must be
  unable to commit even under an application bug. The exact PostgreSQL
  mechanism (a `DEFERRABLE INITIALLY DEFERRED` constraint trigger is the
  preferred starting candidate) is finalized inside Task 3b.1 against the
  acceptance tests in §G, not fixed by this plan.
- **D3b-4 — Accounting periods, close-only in V1.** A minimal company-scoped
  `accounting_period` (`OPEN`/`CLOSED`) is introduced in 3b.1. The posting
  engine may post only into an `OPEN` period and never mutates `CLOSED`
  history. **V1 has no reopen API** — a correction to closed-period history is
  a reversal/corrective entry posted into a currently-open period, referencing
  the original. Advanced statutory reopening workflows are Phase 10.
- **D3b-5 — Customer identity vs. financial relationship.** `customer` is
  **tenant-scoped** identity; the financial/credit relationship
  (`customer_company_account`) is **company-scoped** — the same customer may
  have credit enabled with Company A and disabled with Company B. Internal
  identity is UUID-only; no gapless financial-account numbering is
  implemented. Merge is out of scope; delete is permitted only with zero
  protected financial/transactional history, otherwise archive-only.
- **D3b-6 — Credit requires an identified customer.** Anonymous walk-in sale is
  permitted only when the final transaction leaves **zero** customer-specific
  outstanding obligation. An identified customer is mandatory whenever a
  credit sale, remaining AR, Advance creation/application, Account Credit, or
  Customer Settlement is involved.
- **D3b-7 — Order ≠ Invoice.** `order` is the mutable **operational/commercial**
  transaction; `invoice` is the immutable **financial obligation/document**
  produced when a walk-in order is confirmed. `invoice_payment_status` lives on
  `invoice`, never on the mutable `order`. Both are created by Task 3b.3;
  Task 3b.6 owns the payment-status **derivation logic** against the
  already-existing `invoice` row. Once an invoice is posted, every
  financially-posted `order_line` field it references (unit price, quantity,
  discount, tax category/rate/mode, rounding outcome, totals) is frozen —
  corrections are Cancellation / Credit Note / a new transaction, never an
  in-place edit.
- **D3b-8 — Tax mode is jurisdiction-resolved, never hardcoded.** Both
  `TAX_EXCLUSIVE` and `TAX_INCLUSIVE` are supported architecturally; the mode,
  `rounding_scope` (`LINE`/`DOCUMENT`), and `rounding_mode` are resolved from
  trusted Company/Country fiscal configuration — never Branch/POS/client
  input — and snapshotted on the line. A mandatory **Country Fiscal Policy
  Validation** STOP gate runs immediately before Task 3b.4's implementation,
  validating each supported jurisdiction's actual legal convention before any
  country-specific rule is committed; engineering never silently decides a
  legal tax convention.
- **D3b-9 — First `PaymentProvider` adapter: Tap Payments** (full-GCC coverage
  — UAE, KSA, Kuwait, Bahrain, Qatar, Oman), built strictly behind the
  unchanged ADR-0007 port; a second adapter must be addable with zero
  domain-layer change.
- **D3b-10 — `PaymentAttempt` durable orchestration, network I/O never inside
  the final financial transaction.** A `payment_attempt` is committed in its
  own short transaction **before** any provider call, carrying a stable
  internal id, an internal idempotency key + canonical request fingerprint
  bound to a specific commercial snapshot, expected amount/currency, provider,
  and credential reference. The provider is called using a provider-idempotency
  key derived from the attempt id — our internal retention is never assumed
  safe merely because a provider's own idempotency window happens to still be
  open. Only once success is authoritatively known does **one** final
  financial transaction run (order confirm, invoice, `payment`,
  `payment_allocation`, AR/advance effects, journal, audit, outbox, mark the
  attempt `FINALIZED`). If that transaction fails after a successful capture,
  the attempt remains durable and enables safe local-only re-finalization —
  never a re-charge. `payment_attempt` (orchestration/lifecycle) and `payment`
  (financial receipt) are structurally separate; a `payment` row is created
  **only** on authoritative success.
- **D3b-11 — Multi Payment.** One `order` may resolve through **0..N**
  `payment_attempt`s, **0..N** `payment`s, and **0..N** `payment_allocation`s
  — e.g. Cash 40 + Card 60 against a 100 order, each external component
  receiving its own `payment_attempt` with its own expected amount. Credit and
  Advance are **never** `payment_method_config` rows — they are independent
  resolution mechanisms, not tender types. Final financial issuance requires
  proof that the invoice obligation is **validly and fully** resolved through
  the approved combination of successful payments + explicit advance
  application + allowed AR; a failed or still-pending component never counts
  as money received, and a partially-successful Multi Payment attempt never
  auto-finalizes or auto-invents a refund.
- **D3b-12 — Webhook identity and ingress trust.** Dedup key is
  `(provider, provider_event_key)`, with the **adapter** responsible for
  deriving a trustworthy `provider_event_key` from whatever fields the
  provider actually supplies — never an assumed universal `provider_event_id`.
  The webhook endpoint never trusts payload-supplied `tenant_id`/`company_id`/
  `branch_id` as routing authority; verify signature → dedup → resolve the
  trusted local `payment_attempt`/`provider_credential` → derive tenant/
  company/branch **from that local state** → process idempotently.
- **D3b-13 — PCI / card-data boundary.** No raw PAN, CVV/CVC, magnetic-stripe
  data, or full card-authentication secret is ever stored in the database,
  audit log, outbox, application logs, or webhook tables. Only provider
  references/tokens and bounded, approved metadata are retained; provider-
  hosted/tokenized collection is preferred wherever the adapter allows it;
  retained webhook payloads are minimized, hashed for dedup integrity,
  encrypted at rest if any sensitive-but-permitted data is retained, under an
  explicit retention/deletion policy.
- **D3b-14 — Durable Cancellation / Refund / Credit Note.** `cancellation` is a
  durable workflow record (not merely an Order status + audit row), owning
  0..N `cancellation_line` (partial-line support) and 0..N `refund` (one row
  per actual monetary component — provider, cash, bank, etc.; an Account
  Credit resolution is never a fake `refund`, it is the appropriate `ADVANCE`
  effect referenced from the cancellation). `credit_note` is a separate,
  durable financial-adjustment document, structurally distinct from Settlement
  Discount, Refund, Cancellation Charge, Payment, and Advance — the original
  invoice total is never rewritten. Cancellation-charge results (policy
  id/version, basis, calculated charge, override, reason, actor, approver) are
  **snapshotted onto the cancellation record** — a later policy edit never
  changes a historical result. `refund` uses the same
  persist-before-provider-I/O durability discipline as `payment_attempt`.
- **D3b-15 — Company accounting currency and timezone.**
  `Company.defaultCurrency` (already shipped in Phase 3a/Task 2.7) is reused
  verbatim as the authoritative accounting currency — no duplicate field is
  created. Financial posting **fails closed** if `defaultCurrency` is null.
  Once a company has any posted financial history, ordinary configuration
  must not change its accounting currency — a currency migration with
  historical translation is a separately-designed future workflow, outside
  Phase 3b. No implicit FX conversion anywhere. A **new**, additive nullable
  `Company.accountingTimezone` column is introduced in Task 3b.1 (no
  equivalent field exists anywhere in the current schema — confirmed by direct
  inspection of `packages/db/prisma/schema.prisma`; only `Branch.timezone`
  exists, and it is already forbidden as a fiscal-authority source per Task
  3.9). Financial posting fails closed if `Company.accountingTimezone` is
  missing. It is **never** substituted by Branch timezone, POS timezone,
  browser timezone, or client-supplied timezone/date. A companion additive
  `Country.defaultTimezone` reference column supplies the provisioning-time
  default only; it is never itself the posting authority, and changing it
  later must never silently change an existing company's
  `accountingTimezone` or any historical `posting_date`.
- **D3b-16 — `posting_date` is Company-timezone-derived, server-side only,**
  computed at the moment a financial event is recorded, and used as the
  `(company_id, posting_date)` key for accounting-period lookup. This is a
  **distinct concept** from Task 3.9's tax civil-date contract
  (`?date=YYYY-MM-DD`, a resolution-time input) — the two are never merged
  into one field or one derivation path.
- **D3b-17 — Cash tender/change ≠ financial overpayment.** `payment` records
  only the amount actually retained/applied by the business (Invoice 95,
  tendered 100, change 5 → `Payment = 95`); physical change-making is a Phase
  4 cash-register concern. A genuine retained excess sits in
  `LIABILITY.UNAPPLIED_RECEIPTS` until explicitly allocated, refunded, or
  converted to Advance via a separate, explicit, audited action — never
  automatically.
- **D3b-18 — Reporting is source-derived first.** Phase 3b V1 reports (trial
  balance, AR, Advance, sales, tender totals) read/reconcile directly from
  `journal_line`, the AR/Advance subledgers, `invoice`, and `payment`. No
  cache/rollup table exists merely because Task 3b.10 exists; a materialized
  projection is proposed separately only if measured performance later
  requires it, and remains rebuildable and reconcilable to source, never
  itself authoritative.
- **D3b-19 — No new catalog capability.** Financial-feature availability is
  governed by plan/entitlement/module availability + company financial policy
  configuration + permission + data scope — four separate axes. **No** key is
  added to `CATALOG_CAPABILITY_KEYS` for any Phase 3b feature; payment methods
  are company/branch configuration, never a catalog capability.
- **D3b-20 — Gift Cards deferred.** Gift Cards are explicitly **not** part of
  Phase 3b V1 and are **not** required for `phase-3-complete`. They are never
  modeled as `ADVANCE` or any existing entry kind — a distinct future
  financial instrument, designed in its own later task.

---

## A. Phase 3b architecture summary

### A.1 What this plan covers

This plan schedules, in full, the work `PHASE-3-PLAN.md` §H.3 named but
explicitly declined to schedule: orders, sale tax computation, payments (one
provider adapter), the double-entry GL + posting engine, receivables/credit/
advances, settlement, cancellation/refund/cancellation-charge, the atomic
walk-in sale, and first reporting rollups. It does not re-derive ADR-0019's
operational/accounting model — that model is frozen (§0.1) — this plan turns
it into concrete schema, task boundaries, and hard gates.

### A.2 Scope of this plan — Phase 3b (revenue + financial truth)

Company/Country fiscal foundation (Task 2.7) → catalog price/tax resolution
(Tasks 3.7/3.9) → **this plan**: chart of accounts + posting engine + periods
→ customer/credit core → orders + invoice + numbering → sale tax computation
→ payments (Tap + `PaymentAttempt` + Multi Payment) → receivables → settlement
→ cancellation/refund/credit note → the atomic walk-in sale → first reporting
→ a verification pass and the `phase-3-complete` tag (only after Phase 3a's
own checkpoint and this plan's exit criteria are both satisfied).

### A.3 Order vs. Invoice (binding, D3b-7)

`order` = operational, mutable through its lifecycle (the full, already-named
status vocabulary from `DOMAIN-MODEL.md`'s Order aggregate is created in full;
Phase 3b wires only the walk-in-relevant transitions; Phase 7 activates the
rest with no destructive schema change). `invoice` = financial, immutable
once posted, carrying `invoice_payment_status`. One confirmed walk-in order
produces exactly one invoice. Neither entity duplicates the other's mutable
truth — the invoice references the order/order-line snapshot.

### A.4 One GL per Company / posting discipline

Every posting-worthy Phase 3b event (sale, payment receipt, allocation,
settlement discount, cancellation, refund, write-off, advance conversion/
application) posts **synchronously, inside the same database transaction** as
the domain write (CLAUDE.md rule 18, unchanged) — `(tenant_id, company_id,
source_kind, source_id)` uniqueness makes re-posting a no-op, never a
duplicate. Corrections are reversing entries only; posted history is
append-only.

### A.5 Multi Payment (binding terminology, D3b-1/D3b-11)

See §0.2 D3b-11. This is the sole official term for a sale resolved across
more than one financial component.

### A.6 `PaymentAttempt` / crash-safety discipline

See §0.2 D3b-10 and D3b-14 (the identical discipline is reused for `refund`).
Network I/O with an external provider never occurs inside the transaction
that records the final financial effect of a sale, a refund, or any other
provider-backed operation.

### A.7 Realtime / outbox — reuse the Phase 2-core/3a pipeline unchanged

Exactly the existing outbox → dispatcher → per-tenant Redis Stream → relay →
gateway pipeline, the same cumulative `isAuthorized()` (tenant → company →
branch) check, the same scanned-cursor/replay/resume semantics already proven
through Task 3.10 and its own verification. **No second realtime
architecture.** Exact event-type strings and payload shapes for the order/
invoice/payment family are **not fixed by this plan** — each owning task
performs a consumer analysis + a security/scope analysis + payload bounding +
an authorization review before its event strings are locked, mirroring
exactly how Task 3.10 fixed the catalog event set only once its consumers and
scope model were understood.

### A.8 Currency / timezone authority (Company-scoped, no FX)

See §0.2 D3b-15/D3b-16. Every Phase 3b financial chain — order snapshot,
invoice, payment, allocation, AR, advance, settlement, cancellation, refund,
credit note, journal — uses the owning company's single accounting currency
and its `accountingTimezone`-derived `posting_date`; a mismatch fails safely,
never silently converts.

---

## B. Task 3b.x sequence

| #     | Task                                                      | Migration?                                             | Depends on                           |
| ----- | --------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------ |
| 3b.1  | CoA + Posting Engine + Accounting Periods                 | **yes**                                                | Phase 3a complete                    |
| 3b.2  | CRM / Customer Core                                       | **yes**                                                | 3b.1                                 |
| 3b.3  | Orders + Invoice + Numbering                              | **yes**                                                | 3b.1, 3b.2, Tasks 3.7/3.9 (Phase 3a) |
| 3b.4  | Sale Tax Computation + Rounding                           | no (pending the Country Fiscal Policy Validation gate) | 3b.3                                 |
| 3b.5  | Payments + Tap Adapter + `PaymentAttempt` + Multi Payment | **yes**                                                | 3b.3, 3b.4                           |
| 3b.6  | Receivables / Credit / Advances                           | **yes**                                                | 3b.2, 3b.3, 3b.5                     |
| 3b.7  | Settlement                                                | no                                                     | 3b.6                                 |
| 3b.8  | Cancellation / Refund / Credit Note / Cancellation Charge | **yes**                                                | 3b.6, 3b.7                           |
| 3b.9  | Atomic Walk-in Sale                                       | no (pending a proven orchestration-persistence gap)    | 3b.1–3b.8                            |
| 3b.10 | First Financial Reporting                                 | no (source-derived, D3b-18)                            | 3b.1–3b.9                            |
| 3b.11 | Final Verification + `phase-3-complete`                   | no                                                     | 3b.1–3b.10                           |

Each task is its own STOP-and-approve implementation task, exactly the
discipline already proven across Phase 3a's 3.1–3.11.

---

## C. Schema / RLS matrix (proposed — no migration written here)

All tables below: `ENABLE`+`FORCE ROW LEVEL SECURITY`, tenant-id policy,
`flower_app` non-superuser role, unless marked otherwise.

### C.1 Task 3b.1 — `account`, `accounting_period`, `journal_entry`, `journal_line`

- `account` — `key` (immutable, internal), `display_code`/`display_name`
  (company-editable), `category` (asset/liability/equity/revenue/expense —
  reference table, never a Postgres enum), `company_id`. Seed (D3b-2):

  | Code | Key                                  | Name                        |
  | ---- | ------------------------------------ | --------------------------- |
  | 1000 | `ASSET.CASH_ON_HAND`                 | Cash on Hand                |
  | 1100 | `ASSET.BANK`                         | Bank                        |
  | 1200 | `ASSET.PAYMENT_CLEARING`             | Payment Clearing            |
  | 1300 | `ASSET.ACCOUNTS_RECEIVABLE`          | Accounts Receivable         |
  | 2000 | `LIABILITY.CUSTOMER_ADVANCES`        | Customer Advances           |
  | 2050 | `LIABILITY.UNAPPLIED_RECEIPTS`       | Unapplied Customer Receipts |
  | 2100 | `LIABILITY.TAX_PAYABLE`              | Tax Payable                 |
  | 2200 | `LIABILITY.REFUND_PAYABLE`           | Refund Payable              |
  | 3000 | `EQUITY.RETAINED_EARNINGS`           | Retained Earnings           |
  | 4000 | `REVENUE.SALES`                      | Sales Revenue               |
  | 4100 | `REVENUE.CANCELLATION_CHARGE`        | Cancellation Charge Revenue |
  | 4900 | `CONTRA_REVENUE.SALES_DISCOUNT`      | Sales Discount              |
  | 4910 | `CONTRA_REVENUE.SETTLEMENT_DISCOUNT` | Settlement Discount         |
  | 5000 | `EXPENSE.RECEIVABLE_WRITE_OFF`       | Receivable Write-Off        |

  No `Inventory`/`COGS`/`Purchase`/`AP` key.

- `accounting_period` — `company_id`, `start_date`, `end_date`, `status`
  (`OPEN`/`CLOSED`). Non-overlapping per company; `start_date <= end_date`;
  posting fails closed with no matching `OPEN` period; periods are never
  silently created during a posting; close-only in V1 (D3b-4), step-up +
  audited.
- `journal_entry` — `company_id`, `source_kind`, `source_id`, `period_id`.
  `UNIQUE(tenant_id, company_id, source_kind, source_id)`.
- `journal_line` — `entry_id`, `account_id` (composite FK to
  `(tenant_id, company_id, id)` on `account` — never cross-company), `branch_id?`,
  `pos_terminal_id?`, `shift_id?` (dimensions only), `debit_minor`,
  `credit_minor`. `CHECK (debit_minor >= 0 AND credit_minor >= 0)`;
  `CHECK ((debit_minor > 0)::int + (credit_minor > 0)::int = 1)` (exactly one
  non-zero side). A DB-level backstop (D3b-3) additionally guarantees
  `SUM(debit_minor) = SUM(credit_minor)` per `entry_id`, enforced at commit.
- **`Company.accountingTimezone`** (additive, nullable) and
  **`Country.defaultTimezone`** (additive, nullable, provisioning default
  only) — D3b-15/D3b-16.

### C.2 Task 3b.2 — `customer`, `customer_company_account`

- `customer` — tenant-scoped identity (UUID, name, contact, status).
- `customer_company_account` — company-scoped: `credit_enabled`,
  `credit_limit`, and the cached projection fields `current_outstanding` /
  `available_credit` / `advance_balance`, updated inside the same transaction
  as every subledger write; a reconciliation job re-derives them from the
  event stream and alerts on drift. UUID identity only (D3b-5) — no financial-
  account numbering.

### C.3 Task 3b.3 — `order`, `order_line`, `invoice`

- `order` — the full frozen status vocabulary; tenant + company + branch
  scoped; `pos_terminal_id` origin/attribution only; `acting_user_id`/
  `created_by_user_id` never overwritten (CLAUDE.md rule 12); a company-scoped
  gapless order number, allocated only at final issuance via the proven
  transactional counter-row pattern (never `SEQUENCE`, never `MAX()+1`).
- `order_line` — the immutable commercial snapshot
  (`{variant_id, uom_code, company_id, resolved sell Money, tax_category_key,
rate_bps, effective_from, resolution_source}` plus line discount), captured
  once via Phase 3a's read-only resolution services, **plus** the reserved/
  nullable tax-snapshot fields (`price_tax_mode`, `rounding_scope`,
  `rounding_mode`, computed `line_tax_amount_minor`) whose _population logic_
  belongs to Task 3b.4 (D3b-8/D3b-story on schema ownership) — the columns
  exist from this migration onward even before 3b.4 populates them.
- `invoice` — references `order`; its own company-scoped gapless number
  (independent counter from Order's); posted totals; `invoice_payment_status`
  column exists here, **populated by Task 3b.6's logic**. Immutable once
  posted (D3b-7).

### C.4 Task 3b.4 — no new table

Pure computation + validation against 3b.3's already-existing snapshot
columns, gated by the mandatory Country Fiscal Policy Validation STOP (D3b-8).

### C.5 Task 3b.5 — `payment_method_config`, `payment_attempt`, `payment`, `payment_allocation`, `payment_webhook_event`

- `payment_method_config` — company/branch-scoped enable/disable of `CASH`,
  `CARD_PROVIDER`, `BANK_TRANSFER`. Never `CREDIT`, never `ADVANCE`.
- `payment_attempt` — `tenant_id, company_id, branch_id, acting_principal_id,
order_id, order_snapshot_version, snapshot_fingerprint,
internal_idempotency_key, expected_amount_minor, currency, provider,
provider_credential_ref, status (PENDING→PROVIDER_INITIATED→
PROVIDER_SUCCESS→FINALIZED | FAILED)`. Committed before any network call
  (D3b-10).
- `payment` — created only on authoritative success; `method`, `amount_minor`,
  `currency`, `provider_reference?`, status
  (`REQUIRES_ACTION→AUTHORIZED→CAPTURED→PARTIALLY_REFUNDED→REFUNDED`·
  `FAILED·CANCELED·PENDING`, frozen per ADR-0019 §18.3).
- `payment_allocation` — `payment_id`, `invoice_id`, `amount_minor` —
  structurally separate row (D3b-10/ADR-0019 §8).
- `payment_webhook_event` — `provider`, `provider_event_key`,
  `provider_object_id`, `event_kind`/`status`, `received_at`/`verified_at`/
  `processed_at`, `payload_hash`, bounded retained payload (D3b-13).
  `UNIQUE(provider, provider_event_key)` (D3b-12).

### C.6 Task 3b.6 — `ar_transaction`, `advance_transaction`

13-kind append-only taxonomy (ADR-0019 §10/§31, frozen):
`INVOICE·PAYMENT·PAYMENT_ALLOCATION·SETTLEMENT_DISCOUNT·CREDIT_NOTE·ADVANCE·
ADVANCE_APPLIED·REFUND·WRITE_OFF·ADJUSTMENT·REVERSAL·CANCELLATION_CHARGE·
CANCELLATION_CHARGE_REVERSAL`. `invoice_payment_status` derivation logic
against 3b.3's `invoice` row lives here. A reconciliation job re-derives
`customer_company_account` projections — the likely first new domain
scheduler job; **Phase-2-backlog B14 is an explicit planning gate at this
task**, scheduled alongside it, not implemented earlier.

### C.7 Task 3b.7 — `settlement`

Header only — no independent balance column (ADR-0019 §9, frozen).

### C.8 Task 3b.8 — `cancellation`, `cancellation_line`, `cancellation_charge_policy`, `refund`, `credit_note`

- `cancellation` — tenant/company/branch context, `order_id`, `invoice_id`,
  status, reason, `requested_by`, `approved_by?`, `policy_id`/`version`,
  original monetary eligibility, **snapshotted** charge calculation (basis,
  calculated, override, final, reason, actor, approver), final resolution,
  timestamps/version.
- `cancellation_line` — references the specific affected immutable
  `order_line`(s), for partial cancellation.
- `cancellation_charge_policy` — tenant/company-configurable (no charge /
  fixed / percentage / minimum / time-based / stage-based — configuration,
  never a code branch, ADR-0018 §6 discipline applied to financial policy).
- `refund` — **0..N per cancellation**; `provider|cash|bank|other`, requested
  vs. actual amount/currency, provider + provider refund reference, status,
  idempotency key/fingerprint, `requested_by`/`approved_by?`,
  timestamps/version. Same persist-before-provider-I/O durability as
  `payment_attempt` (D3b-14).
- `credit_note` — `invoice_id`, `cancellation_id`/source, number, reason,
  original-amount-affected, tax-adjustment snapshot, total credit amount,
  status, `issued_at`, fiscal-adapter reference. Structurally distinct from
  Settlement Discount / Refund / Cancellation Charge / Payment / Advance;
  never rewrites the original invoice total.

### C.9 Task 3b.9 — no new table

Pure orchestration over 3b.1–3b.8's tables, unless implementation proves a
genuine persistence gap (to be reported, not assumed).

### C.10 Task 3b.10 — no new table (D3b-18)

Source-derived views/read services over `journal_line`, `ar_transaction`/
`advance_transaction`, `invoice`, `payment`. A cache/rollup table is a
separate future proposal only if measured performance requires it.

### C.11 Migration & baseline rules

Every migration above is additive/forward-only (CLAUDE.md rule 37); no table
listed here is ever destructively altered by a later Phase 3b task. No
Inventory/Purchase/Supplier-AP/Gift-Card/BOM/Z-Report table exists anywhere in
this plan.

---

## D. API matrix (Phase 3b, high-level — exact routes are task-level detail)

| Task  | Surface (representative)                                                     |
| ----- | ---------------------------------------------------------------------------- |
| 3b.1  | Owner-facing CoA read; Super-Admin/Owner period close                        |
| 3b.2  | Customer CRUD; per-company credit configuration/override                     |
| 3b.3  | Order create/confirm (DRAFT→CONFIRMED), Invoice read                         |
| 3b.4  | (no new route — tax computation is invoked internally by 3b.3/3b.9)          |
| 3b.5  | Payment-method config; PaymentAttempt create; provider webhook ingress       |
| 3b.6  | AR/Advance read; explicit Advance-creation and Advance-application actions   |
| 3b.7  | Settlement process (AUTO/manual, discount toggle)                            |
| 3b.8  | Cancellation create (full/partial); Refund; Credit Note issuance             |
| 3b.9  | The atomic walk-in sale endpoint (Multi Payment-capable)                     |
| 3b.10 | Reporting read endpoints (trial balance, AR, advances, sales, tender totals) |
| 3b.11 | none (verification only)                                                     |

Exact request/response shapes, headers (`If-Match`/`Idempotency-Key` per
route), and error codes are frozen inside each task, following the same
rigor as every Phase 3a task's own §D rows.

---

## E. Permission / entitlement matrix

### E.1 Permissions

`accounting:view`, `accounting:manage`, `accounting:period:manage`,
`customers:view`, `customers:manage`, `customers:credit:manage`,
`customers:credit:override`, `orders:view`, `orders:manage`, `orders:cancel`,
`payments:view`, `payments:manage`, `payments:refund`, `receivables:view`,
`receivables:manage`, `receivables:advance:manage`, `receivables:write_off`,
`receivables:credit_note:issue`, `settlement:view`, `settlement:manage`,
`settlement:manual_allocate`, `settlement:discount:apply`,
`cancellation_charge:override`, `reporting:view`.

Step-up required for: credit override, write-off, settlement discount,
policy-gated manual settlement, refund, cancellation-charge override,
accounting-period close, and Credit Note issuance where tenant policy
requires it — mirroring CLAUDE.md rule 13.

### E.2 Four layers — all applied (unchanged discipline, D2-5 extended)

`Entitlement ≠ Catalog Capability ≠ Permission ≠ Business Type`, now with a
fifth axis made explicit for Phase 3b: **company financial policy/config**
(e.g. `customer_company_account.credit_enabled`,
`payment_method_config`). No Phase 3b feature is gated by a
`CATALOG_CAPABILITY_KEYS` entry (D3b-19).

---

## F. Event / realtime matrix

Reuses the unchanged outbox→dispatcher→stream→relay→gateway pipeline and the
cumulative `isAuthorized()` check (tenant→company→branch). Named families
anticipated (not frozen — A.7/D3b): an operational `order.*` family
(`order.created`/`order.updated`/`order.status_changed`) and a financial
`payment.updated`/invoice-status-changed family. Each owning task performs its
own consumer + security/scope + payload-bounding + authorization review
before locking exact strings, exactly mirroring how Task 3.10 fixed its 5
`catalog.*` events only after that analysis.

---

## G. Hard-gate matrix (Phase 3b — build-blocking at the task that introduces each)

| Gate                          | Proof required                                                                                                                                                                         |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HG3b-COA                      | DB backstop rejects an unbalanced insert; account-key immutability                                                                                                                     |
| HG3b-PERIOD-INTEGRITY         | no overlap, no silent creation, `CLOSED` rejects posting, close-only (no reopen)                                                                                                       |
| HG3b-POSTING-DATE             | Company-timezone-derived, never branch/POS/client; immutable after later config change                                                                                                 |
| HG3b-CREDIT-CONCURRENCY       | parallel credit sales never both exceed the limit                                                                                                                                      |
| HG3b-ORDER-INVOICE-SPLIT      | a posted invoice's referenced order-line fields never drift                                                                                                                            |
| HG3b-TAX-MODE                 | both EXCLUSIVE/INCLUSIVE paths; line vs. document rounding                                                                                                                             |
| HG3b-PRE-PAYMENT-SNAPSHOT     | finalization uses the attempt-bound snapshot even if catalog price/tax later changes                                                                                                   |
| HG3b-PAYMENT-ATTEMPT          | provider-success/local-failure recovers without re-charging; crash-before-response-persisted still recoverable                                                                         |
| HG3b-MULTI-PAYMENT            | every named combination + failed/pending component + retry-after-partial-success, no duplicate effects                                                                                 |
| HG3b-WEBHOOK-DEDUP            | `(provider, provider_event_key)` uniqueness; concurrent duplicate delivery never double-finalizes                                                                                      |
| HG3b-PCI                      | structural guard — no card-secret-shaped field anywhere in DB/audit/outbox/logs                                                                                                        |
| HG3b-AR                       | all invoice states + reconciliation invariant                                                                                                                                          |
| HG3b-ADVANCE-CONCURRENCY      | no double-spend of an advance balance                                                                                                                                                  |
| HG3b-SETTLEMENT               | AUTO-FIFO determinism, manual, discount, approval, reversal                                                                                                                            |
| HG3b-CANCEL-REFUND-CREDITNOTE | every ADR-0019 Part B scenario + full reconstructible chains for Cancellation/Refund/Credit Note                                                                                       |
| HG3b-GL                       | every posting template (unallocated cash/provider receipt, allocate-to-invoice, convert-to-advance, apply-advance, credit-sale, write-off) balances, is source-idempotent, append-only |
| HG3b-ATOMIC-SALE              | one successful commit / failure rollback / retry / concurrent request / outbox-audit-journal consistency                                                                               |
| HG3b-CURRENCY-LOCK            | mismatch fails safe; post-history currency change blocked                                                                                                                              |
| HG3b-SECURITY                 | cross-tenant/company/branch denial; POS origin never an isolation axis; RLS                                                                                                            |
| HG3b-REALTIME                 | scoping, resume/replay, narrowing, cursor — reusing the proven 3a suite pattern                                                                                                        |
| HG3b-NO-BT-BRANCH             | structural gate extended to every new Phase 3b file                                                                                                                                    |
| HG3b-REGRESSION               | the full Phase 0 → 3a suite stays green after every Phase 3b task                                                                                                                      |
| HG3b-CI                       | `verify`/`security`/`e2e`/`realtime` green on every Phase 3b PR                                                                                                                        |

---

## H. Later-phase / non-scope matrix

### H.1 Explicitly OUT of Phase 3b

| Item                                                                                                  | Phase                                |
| ----------------------------------------------------------------------------------------------------- | ------------------------------------ |
| Inventory movement ledger, `branch_inventory_balance`, stock reservation, barcode receiving           | 5                                    |
| Purchasing / GRN / supplier bills / supplier returns (ADR-0020)                                       | 5                                    |
| Batch/lot/expiry enforcement, FEFO/FIFO consumption                                                   | 5                                    |
| BOM / recipe / bouquet-hamper composition execution, production/work orders, raw-material consumption | 6                                    |
| Cash register / POS shift / X-Report / Z-Report / expenses / other income                             | 4                                    |
| Gift Cards                                                                                            | deferred beyond Phase 3b V1 (D3b-20) |
| Customer Web storefront / online orders / delivery                                                    | 7                                    |
| Workforce                                                                                             | 8                                    |
| AI / WhatsApp                                                                                         | 9                                    |
| Statutory reporting depth, DR drills, biometric, promotions/loyalty/subscriptions, OCR, load testing  | 10                                   |

### H.2 Phase 5 costing requirement preserved (not designed or implemented here)

Recorded so Phase 3b's CoA/schema (no Inventory/COGS accounts, no
disposition hooks) does not foreclose it: purchase-cost layers remain
permanently separate — e.g. 100 units @ AED 2 never blends with a later 10
units @ AED 3; **no weighted-average/average-cost model**; valuation is the
sum of remaining layer values; expiry-tracked stock consumes **FEFO**;
non-expiry stock consumes **FIFO**.

---

## I. Open owner decisions

**None remaining that block implementation.** Every decision materially
affecting schema shared across more than one task (Invoice's home task,
Order≠Invoice, period-reopen policy, customer-account identity, CoA seed,
currency/timezone authority, the Cancellation/Refund/Credit-Note relationship,
the pre-provider snapshot-to-`PaymentAttempt` binding, and the Multi Payment
cardinality model) is frozen in §0.2. The following are **task-local process
gates**, not open plan-level decisions: the Country Fiscal Policy Validation
STOP gate (3b.4, D3b-8); Credit Note/Refund exact numbering scheme (3b.8); the
exact DB balance-backstop mechanism (3b.1, D3b-3); exact realtime event
strings (per-task, §F); which single permission gates any narrow edge case
not explicitly named in §E.1 (resolved task-by-task, as Phase 3a did).

---

## J. Proposed first implementation task (after this plan is approved)

> **Task 3b.1 — Chart of Accounts, Posting Engine, Accounting Periods.**

| Field                           | Detail                                                                                                                                                                                                                                                                                                                              |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Goal**                        | A company can post a balanced, idempotent journal entry; a period can be closed; no unbalanced entry can ever commit. **No order/payment/customer domain code.**                                                                                                                                                                    |
| **Scope**                       | `account` (seeded per §C.1) · `accounting_period` · `journal_entry` · `journal_line` · the DB-level balance backstop · `Company.accountingTimezone` + `Country.defaultTimezone` (additive) · the posting-engine internal API the later tasks call · default CoA seeding on tenant/company provisioning (additive, non-destructive). |
| **Models / tables**             | `account`, `accounting_period`, `journal_entry`, `journal_line`, `Company.accountingTimezone`, `Country.defaultTimezone`                                                                                                                                                                                                            |
| **Permissions**                 | `accounting:view`, `accounting:manage`, `accounting:period:manage` (step-up)                                                                                                                                                                                                                                                        |
| **Entitlements / capabilities** | none — no `CATALOG_CAPABILITY_KEYS` change (D3b-19)                                                                                                                                                                                                                                                                                 |
| **RLS / isolation**             | `account`/`accounting_period`/`journal_entry`/`journal_line` — `ENABLE`+`FORCE` + tenant policy; `account.key` immutable post-seed                                                                                                                                                                                                  |
| **Concurrency / idempotency**   | `(tenant_id, company_id, source_kind, source_id)` UNIQUE on `journal_entry` — re-posting is a no-op, never a duplicate                                                                                                                                                                                                              |
| **Audit**                       | `accounting.journal_posted`, `accounting.period_closed` (step-up, no reopen action exists)                                                                                                                                                                                                                                          |
| **Outbox / realtime**           | none — an internal accounting primitive, not a client-facing catalog-style event                                                                                                                                                                                                                                                    |
| **Tests**                       | HG3b-COA, HG3b-PERIOD-INTEGRITY, HG3b-POSTING-DATE (posting-date derivation from `Company.accountingTimezone`, immutable historically), full GL posting-template acceptance tests (§G)                                                                                                                                              |
| **Hard gate**                   | HG3b-COA · HG3b-PERIOD-INTEGRITY · HG3b-POSTING-DATE · HG3b-SECURITY · HG3b-REGRESSION · HG3b-CI                                                                                                                                                                                                                                    |
| **Explicit non-scope**          | no `order`/`customer`/`payment`/`invoice` table or API; no Phase 3b.2+ anything; no Inventory/COGS account                                                                                                                                                                                                                          |
| **Depends on**                  | Phase 3a complete (`phase-3a-catalog-complete`)                                                                                                                                                                                                                                                                                     |

---

## K. Documentation corrections this plan records (proposed — not applied by this plan)

1. **`ROADMAP.md` §Phase 3** — append under the existing header (no other line
   changed): _"Phase 3 executes as two owner-approved sub-phases: **3a**
   (catalog/UOM/identifiers/pricing/tax-reference foundation — complete,
   `phase-3a-catalog-complete`) then **3b** (orders/payments/GL/receivables/
   settlement/cancellation/refund — this section's remaining scope).
   `phase-3-complete` requires both."_
2. **`ROADMAP.md` §Phase 3 module list** — change
   `"receivables (AR / credit / advances / gift cards)"` to
   `"receivables (AR / credit / advances — gift cards explicitly deferred
beyond Phase 3b V1, not required for phase-3-complete)"`.

No other `ROADMAP.md` line, the module list order, or the Exit criterion is
changed. No ADR is amended; ADR-0019/ADR-0007/ADR-0018 remain exactly as
written. `DECISION-LOG.md` is unchanged — it records only the original 23
approved architecture decisions (Z-1…Z-14, ZF-1…ZF-9); phase-level decisions
have always lived in each phase's own plan document, not there (matching
every prior Phase 1/2/3a plan's own precedent).
