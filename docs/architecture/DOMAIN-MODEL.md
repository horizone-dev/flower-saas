# Flower SaaS — Domain model

> Consolidated entities + relationships (architecture §52) and financial concepts
> (§F / §13 of the v0.3 revision). No migrations, no exhaustive columns. This is a
> conceptual model; the authoritative schema is `packages/db/prisma/schema.prisma`
> once it exists (from Phase 1 onward).

## Conventions

- **IDs**: UUID v7 everywhere.
- **`tenant_id`** on every tenant-owned row; **`company_id`** + **`branch_id`** on
  operational rows.
- **Audit columns**: `created_at`, `created_by`, `updated_at`, `updated_by`.
- **Money**: `amount_minor BIGINT` + `currency_code` + `currency_exponent`
  (2 for AED/SAR/QAR, 3 for KWD/BHD/OMR). Never floating point.
- **Quantities**: `NUMERIC(18,4)` stored in the item's base UOM.
- **Extensible concepts** (statuses, kinds, reasons, doc types, channels) are
  **strings + reference tables**, not PostgreSQL enums.
- **Ledgers are append-only**: `inventory_movement`, `cash_movement`, `journal_entry`
  / `journal_line`, `payment_event`, `audit_log`, `attendance_event`. Balances are
  derived projections.

## Core relationships

- **Tenant** 1─* Company 1─* Branch 1─* POSTerminal 1─* POSDevice. All operational
  rows carry `branch_id`.
- **User** _─_ Role _─_ Permission; User 1─* ScopeAssignment; User 0..1─0..1 Staff.
  Staff 1─* Schedule / Leave / AttendanceEvent; Staff *─1 Branch (home).
- **Product** 1─* ProductVariant; Variant 1─* Identifier (barcode / QR / SKU).
  Variant strategy: `STOCKED` → 1 InventoryItem (`FINISHED_GOOD`); `BOM` → 1 Recipe;
  `CUSTOM` → composed per OrderLine.
- **Recipe** 1─* RecipeComponent _─1 InventoryItem. **CustomBouquet** 1─_
  CustomBouquetComponent (each a snapshot of an InventoryItem — name / qty / UOM /
  unit cost / line cost snapshotted).
- **InventoryItem** _─1 UnitOfMeasure (base); 1─_ Lot; per Branch → 1
  BranchInventoryBalance; 1─* InventoryMovement; 1─* StockReservation; 1─* Wastage.
- **Order** 1─* OrderLine; 1─* OrderStaffAttribution; 1─* Payment→Allocation; 1─0..1
  Delivery; *─1 Customer; 0..1 Recipient; 0..1 AiConversation. OrderLine → (Variant
  | Recipe explosion | CustomBouquet) → StockReservation(s) → WorkOrder →
  MaterialConsumption → InventoryMovement.
- **Supplier** 1─* Purchase 1─* PurchaseLine; receiving → InventoryMovement
  (`PURCHASE_RECEIPT`). Supplier / Purchase 1─* Document.
- **Document** attaches to any entity via `(owner_type, owner_id)`.
- **AttendanceDevice** 1─* StaffDeviceMapping *─1 Staff; ingest → AttendanceEvent
  *─1 Staff, *─1 Branch.

## Order aggregate

`order` dimensions: `channel` (`POS · CUSTOMER_WEB · WHATSAPP_AI · CUSTOMER_WEB_AI ·
PHONE · MANUAL · MARKETPLACE:*`), `kind` (`WALK_IN · PICKUP · DELIVERY · SCHEDULED ·
EVENT · SUBSCRIPTION_INSTANCE · QUOTATION`), `origin_branch_id`,
`fulfilling_branch_id`, `company_id`, `tenant_id`. Gifting: `recipient_id?`,
`card_message?`, `hide_price`, `substitution_policy`. Identity:
`created_by_user_id` / `acting_user_id` (never overwritten). Attribution:
`order_staff_attribution(order_id, role_key ∈ {SALESPERSON, FLORIST, CASHIER,
APPROVER, DRIVER}, staff_id, set_by_user_id, set_at)`.

State machine (per kind): `DRAFT/HELD → PLACED → CONFIRMED → IN_PRODUCTION → READY →
OUT_FOR_DELIVERY / AWAITING_PICKUP → COMPLETED/DELIVERED` + `REJECTED · CANCELLED ·
PAYMENT_FAILED · REFUNDED · DELIVERY_FAILED · RESCHEDULED`.

## Inventory

`inventory_movement(id, tenant_id, branch_id, item_id, lot_id?, category, qty_base
(signed), unit_cost?, ref_kind, ref_id, reservation_id?, acting_user_id, staff_id?,
occurred_at, idempotency_key)`. Categories: `PURCHASE_RECEIPT · STOCK_IN · SALE ·
MATERIAL_CONSUMPTION · PRODUCTION_OUTPUT · CUSTOMER_RETURN · SUPPLIER_RETURN ·
ADJUSTMENT_IN · ADJUSTMENT_OUT · WASTAGE · SPOILAGE · TRANSFER_IN · TRANSFER_OUT`.

`branch_inventory_balance(tenant_id, branch_id, item_id, on_hand_base,
reserved_base, available_base GENERATED, avg_cost, version, updated_at)` — projection
of the ledger + open reservations.

`stock_reservation(id, tenant_id, branch_id, item_id, lot_id?, qty_base, source_kind
∈ {ORDER_LINE, WORK_ORDER, SOFT_HOLD}, source_id, status ∈ {HELD, PARTIALLY_CONSUMED,
CONSUMED, RELEASED, EXPIRED}, fulfilment_date?, expires_at?, created_at)`.

## Financial concepts — proper accounting boundaries (not one table per noun)

| Concept                              | Modelled as                                                                                                                                            | Why this boundary                                                                 |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| Chart of Accounts / Account          | `account` (per company, typed, hierarchical, keyed for the posting engine)                                                                             | one extensible CoA per legal entity; posting engine resolves stable keys, not ids |
| Journal / JournalEntry / JournalLine | `journal_entry` (balanced, immutable, `source_kind+source_id` unique) 1─* `journal_line` (account, debit/credit, dimensions: company/branch/pos/shift) | no separate "Journal" header table — the entry _is_ the unit                      |
| AccountingPeriod                     | `accounting_period` (company, period, OPEN/SOFT_CLOSED/LOCKED)                                                                                         | period control without freezing operational data                                  |
| Expense / ExpenseCategory            | `expense` + `expense_category` (category → account, approval rules)                                                                                    | operational capture + workflow; posts to GL on approve/pay                        |
| Income / OtherIncome                 | `other_income` (manual only) — sales revenue stays on order+payment                                                                                    | keeps system revenue linked to its source                                         |
| CashRegister                         | `cash_register` (POS-terminal-scoped)                                                                                                                  | physical cash is terminal-specific even though order data is branch-shared        |
| RegisterSession / POSShift           | `register_session` (open float → movements → count → close → Z)                                                                                        | one entity for register session and shift; no duplication                         |
| CashMovement                         | `cash_movement` (append-only, typed, source-referenced, session-scoped)                                                                                | the drawer's ledger; balance is derived, never edited                             |
| XReport                              | _computed_, optional `x_report_log` only                                                                                                               | interim & repeatable — nothing to freeze                                          |
| ZReport                              | `z_report` + `z_report_line` (immutable snapshot, hash-chained, gapless `z_number`) + optional `business_day_close`                                    | finalized financial truth — frozen, never rebuilt                                 |
| CustomerReceivable                   | _balance_ = AR control account; detail in `ar_transaction` subledger (in `receivables`)                                                                | a standalone table would drift from the GL; subledger reconciles to control       |
| CustomerAdvance                      | Customer Advances liability account + `advance_transaction` subledger                                                                                  | advance is a liability, not revenue, until applied                                |
| SupplierPayable                      | AP control account + `supplier_balance` / bill detail in `procurement`                                                                                 | procurement owns supplier detail; it reconciles to AP                             |
| Tax / VAT configuration              | `country_tax_config` + `tax_category` + `tax_rate` (in `localization`/`tax`); VAT Output / VAT Input accounts in the GL                                | config drives calculation; GL drives the return                                   |

### Posting flow

Operational events (order settlement, payment/refund, cash movement, expense/income,
purchase receipt, consumption/wastage) → **posting engine** (event → template →
entry) → `journal_entry` (balanced) 1─* `journal_line` (Dr/Cr + dimensions) → resolve
`account` (CoA). Unique `source_kind + source_id` → idempotent, no double-post.
Reports (trial balance / P&L), subledger reconciliation and the Z-Report snapshot
read the GL + cash-movement ledger; the Z snapshot is frozen at close.

## Business Type templates & tenant catalog capability configuration (ADR-0018, additive)

> Added 2026-09-05. Architecture/documentation only — no schema exists yet; this is
> the conceptual model for Phase 3 to design against. See
> [ADR-0018](../decisions/ADR-0018.md).

- **BusinessTypeTemplate** (platform-global, RLS-exempt reference data, like
  `Country`/`Currency`): `key` (Flower Shop / Perfume Shop / Bakery / Gift-Hamper
  Shop / Chocolate Shop / Balloon-Party Shop / Plant-Nursery / General Retail /
  Custom), suggested categories, attribute templates, variant templates, UOM
  templates, recommended capability preset. Written only by Super Admin.
- **Tenant** gains a nullable `business_type_key` → `BusinessTypeTemplate` — applied
  **once** at provisioning or explicit re-application; never read at runtime to
  branch behaviour (ADR-0018 §1).
- **TenantCatalogCapability** (tenant-scoped, RLS-protected, Super-Admin write /
  Owner-Admin read+operate-within — same entitlement-axis pattern as §48's feature
  modules, not a new axis): which `fulfilment_strategy` values are enabled, which
  default categories/attribute templates/variant templates/UOM templates are
  active, inventory behaviour toggles (lot/batch, expiry), BOM/recipe capability,
  custom composition/bundle capability, and independent POS-visible /
  Customer-Web-visible flags per capability.
- **Generalized naming going forward:** `CustomBouquet`/`CustomBouquetComponent`
  above remain the correct, unrewritten names for the v0.4 design as documented;
  new Phase 3/6 schema and code use **`CustomComposition`** /
  **`CompositionComponent`** for the same `CUSTOM`-strategy mechanism, generalized
  to bouquets, hampers, gift boxes and bundles alike.
- **Identified schema gap, not resolved here:** `Variant` prices once (base price ±
  per-branch price); the requirement needs price **per selling UOM tier** (a Box of
  12 priced independently from a loose Piece of the same item, distinct from mere
  quantity × unit price). Provisional shape for Phase 3 design:
  `VariantUomPrice(variant_id, uom_id, sell_price, purchase_price?, branch_id?)`,
  with the base-UOM price remaining the always-present default. `ItemIdentifier`
  already supports a distinct barcode/QR/SKU per pack level
  (`pack_uom`/`pack_qty`) — only price-per-UOM is the new gap, not
  identifier-per-UOM.

## Customer receivables, settlement & invoice payment-state (ADR-0019, additive)

> Added 2026-09-05. Architecture/documentation only — no schema exists yet; this is
> the conceptual model for Phase 3 to design against. See
> [ADR-0019](../decisions/ADR-0019.md). A separate decision area from the
> Business-Type/catalog model above (ADR-0018) — deliberately not merged.

- **Customer** gains derived (never hand-edited) fields: `credit_enabled`,
  `credit_limit`, `current_outstanding`, `available_credit` (=
  `credit_limit − current_outstanding`), `advance_balance` — all computed from the
  event streams below via the reconciliation invariant, never a directly-writable
  balance column.
- **Invoice payment status** — a third state machine on the order/invoice,
  independent of the `Order` fulfilment state machine (above) and the `Payment`
  state machine (`REQUIRES_ACTION → … → CAPTURED → REFUNDED`): `UNPAID → PARTIAL →
{PAID | SETTLED} · PARTIALLY_REFUNDED → REFUNDED · CANCELLED/VOID`. UNPAID = no
  obligation satisfied; PARTIAL = outstanding > 0 after valid allocations/
  adjustments; **PAID** = outstanding = 0, satisfied entirely by actual monetary
  value (payment allocation and/or eligible advance applied), zero non-payment
  adjustment involved; **SETTLED** = outstanding = 0, with at least part
  extinguished by an approved settlement discount/write-down. Always computed from
  the ledger entries below, never set directly; every invoice view exposes total /
  actual paid / settlement discount / outstanding / status as separate fields.
- **Payment** (a receipt of actual money) 1─* **PaymentAllocation** (applying some
  or all of that receipt to one specific invoice). A `Payment` increases an
  unapplied/available customer amount; a `PaymentAllocation` reduces one invoice's
  outstanding and consumes that amount from the pool — the two are never summed as
  independent reductions. Full immediate allocation may be written atomically in
  one transaction, but remains two separately-reconcilable rows.
- **Settlement** — a grouping/workflow **header only** (id, customer, initiated-by,
  timestamp, toggle states in effect, references to the `Payment`/
  `PaymentAllocation`/`SettlementDiscount`/`AdvanceApplied` rows it orchestrated).
  Carries **no value field that participates in balance arithmetic** — the
  component entries carry all monetary effect; summing them equals exactly what
  moved. Default allocation: AUTO FIFO, ordered deterministically by each
  invoice's authoritative posting/issue sequence (never DB row-return order), with
  an id-based tie-breaker. Two independent, default-OFF flags: manual payment
  allocation (server-validated per ADR-0019 §4) and settlement discount
  (per-invoice, requires reason/applied-by/approval/approved-by/timestamp/audit,
  never mutates the invoice total). When AUTO allocation + discount are both
  active, the server recalculates the FIFO allocation against each invoice's
  post-discount remaining outstanding and surfaces it for confirmation before the
  client can finalize — the client never computes this itself.
- **Unallocated payment** (received beyond what was allocated) stays explicit and
  unapplied; it becomes a `Advance` only through the approved advance flow, with a
  preserved reference back to the originating `Payment`. `AdvanceApplied` counts
  as actual monetary value for the PAID determination.
- **Customer subledger** (`ar_transaction` / `advance_transaction`, already named
  above) gains an explicit entry-kind taxonomy: `INVOICE · PAYMENT ·
PAYMENT_ALLOCATION · SETTLEMENT_DISCOUNT · CREDIT_NOTE · ADVANCE ·
ADVANCE_APPLIED · REFUND · WRITE_OFF · ADJUSTMENT · REVERSAL` — `SETTLEMENT` is
  deliberately not an entry kind (it is the header concept above, per ADR-0019
  §9). Append-only; `current_outstanding`/`advance_balance` are projections over
  this stream, exactly like `branch_inventory_balance` is a projection over
  `inventory_movement`. Corrections are `REVERSAL` + a new corrected entry, never
  an edit.
- **Reconciliation invariant**: `outstanding = original obligation − Σ payment
allocations − Σ advance applied − Σ settlement discounts − Σ credit
notes/write-downs + Σ reversals/valid adjustments` — always provable from the
  event stream, never a manually edited balance.
- **Discount types stay separate**: line-item sale discount / invoice-order
  discount / promotion-coupon (existing, sale-time, contra-revenue) vs. settlement
  discount (new — post-sale, against an existing receivable, its own account and
  approval path).

## Cancellation, refund & customer account credit (ADR-0019 Part B, additive)

> Added 2026-09-05. Architecture/documentation only. See
> [ADR-0019 Part B](../decisions/ADR-0019.md) (§17–§37).

- **Six independent lifecycle fields**, never collapsed: Order status
  (existing, unchanged — its own `REFUNDED`/`PAYMENT_FAILED` values are a
  permitted coarse projection only, never the refund source of truth), Invoice
  payment status (above), Payment status (existing), a **derived** Receivable
  status (`CLEAR` / `OUTSTANDING` / `ADVANCE_HELD` / `MIXED`, computed from the
  reconciliation invariant, not stored), a new Refund status
  (`NONE → PENDING → {COMPLETED | PARTIAL | FAILED} · REVERSED`), and a new
  per-line Inventory-disposition status (`PENDING_DISPOSITION → …`).
- **Cancellation** references specific order line(s) (supports partial/
  line-level cancellation) and drives a monetary-resolution computation over
  only the actually-received value on the cancelled portion — never the
  nominal total.
- **Refund** / **AccountCredit resolution**: a cancellation's eligible
  refundable/creditable amount may be split across one or more `Refund`
  entries (money leaving the business) and/or an `Advance` entry (§ above —
  Account Credit is the same `Advance` mechanism, distinguished only by a
  `source_kind` reference to the cancellation, never a second balance-bearing
  concept). Validated so the sum of every component never exceeds the
  eligible amount.
- **CancellationCharge** 0..1─1 **CancellationChargeReversal** — a first-class
  entry kind, separate from every discount type, with a stored policy
  version + calculation base so the charge is reproducible from stored data
  alone; may itself become a standalone fee-document/receivable when it
  exceeds the amount actually paid (never a mutation of the original
  invoice). Overridable (audited: original calculated value, policy used,
  final value, reason, applied-by, approved-by, timestamp).
- **Settled-invoice cancellation** reverses both the original receivable and
  the `SettlementDiscount` effect (via a `Reversal` entry against it) —
  the refundable base is the actual payment, never the waived discount.
- **Inventory disposition on cancellation** is decided from physical state,
  never derived from the cancellation charge: reservation release,
  `CUSTOMER_RETURN` restocking, or (for already-produced BOM/custom items)
  `RETURN_TO_STOCK` / `FINISHED_GOOD_STOCK_IN` / `REUSABLE_COMPONENT_RETURN` /
  `WASTAGE` / `SPOILAGE` / `SCRAP` — through the single existing inventory
  movement engine, unchanged.
- **Extended subledger taxonomy**: adds `CANCELLATION_CHARGE` /
  `CANCELLATION_CHARGE_REVERSAL` to the entry-kind list above; `SETTLEMENT`
  remains excluded (still a header concept, §9).
- **Reconciliation invariant, extended**: `outstanding / refundable / advance
state` is provable by additionally subtracting valid cancellation reversals
  and applying cancellation charges, refunds, and account-credit
  creation/application, signed per their direction — still never a manually
  edited balance.

## Partitioning (from migration #1)

`order`, `order_line`, `payment_event`, `inventory_movement`, `stock_reservation`,
`journal_entry`, `journal_line`, `cash_movement`, `attendance_event`, `audit_log`,
`ai_message`, `notification_log`, `outbox`, `idempotency_key` — range on
`created_at` (or hash on a tenant bucket for the largest).

## Ledger invariants (DB-enforced)

- Σ(debit) = Σ(credit) per `journal_entry` (constraint / trigger).
- `(source_kind, source_id)` unique on `journal_entry`.
- Posting into a `LOCKED` `accounting_period` rejected at the service layer with an
  audited override path.
- `balance.reserved_base` = Σ open (HELD + PARTIALLY_CONSUMED) reservations for
  `(branch, item)`; `available` = `on_hand − reserved`.
