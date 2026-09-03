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
