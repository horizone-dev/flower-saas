# Flower SaaS — Phased implementation roadmap

> Frozen with architecture v0.4 (2026-09-03). Eleven phases, dependency-ordered,
> foundation-heavy at the front. The financial foundation (double-entry GL +
> receivables in Phase 3; cash register + shift + X/Z-Report + expenses in Phase 4)
> is core, not late. **Every phase ends with:** tests green + a security review + a
> tenant-isolation review + a branch-isolation review before a stable commit, then
> an annotated `phase-<n>-complete` tag, then **STOP for explicit owner approval**
> before the next phase.

| Class | Meaning                                | Where                                                                                                                                                             |
| ----- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A** | Foundation required now                | Phases 0–4                                                                                                                                                        |
| **B** | Core product phase                     | Phases 3–9                                                                                                                                                        |
| **C** | Required later, architecture-ready now | Phases 9–10 (biometric adapters, e-invoicing impl, OCR, route optimization, subscriptions/events UI, advanced accounting & statements, branch business-day close) |
| **D** | Optional future extension              | external accounting-software integration, marketplace integrations, analytics warehouse, demand forecasting, hardware bridge, multi-region                        |

No explicitly-required feature is classed D. AI (both channels), biometric
attendance _architecture_, Customer Web, BOM, custom bouquet, reservation, realtime,
the double-entry GL, cash register / shift and X/Z-Report are all A or B.

---

## Phase 0 — Repo & infrastructure foundation _(no domain code)_

- **Objective**: reproducible dev environment + a CI pipeline that can enforce the
  rules the plan relies on.
- **Modules**: none. **DB**: Postgres + Redis + MinIO + ClamAV via compose; empty
  Prisma schema; migration tooling. **Spike**: RLS + `SET LOCAL` + pooling with
  Prisma → go/no-go (Z-5).
- **Backend**: NestJS skeleton (`api`), health/config/error/logging, OpenAPI
  scaffold, `worker`/`scheduler`/`realtime` stubs. **Frontend**: 4 Next.js
  skeletons; `packages/*` scaffolded; design-system shell.
- **Realtime**: gateway process boots, no topics yet. **Security**: CI gates —
  typecheck, lint (boundary + no-raw-model + route-permission),
  audit/Trivy/SBOM/secret-scan.
- **Tests**: Vitest + Testcontainers wired; a trivial health e2e. **Isolation
  tests**: harness scaffolded.
- **Exit**: RLS spike decided (ADR-0010); CI enforces boundaries; one-command local
  stack; `docker compose up` → all healthy; CI green on empty PR.

Full breakdown: [`../phase-0/PHASE-0-PLAN.md`](../phase-0/PHASE-0-PLAN.md).

## Phase 1 — Identity, tenancy, RBAC, entitlements, Super Admin MVP _(isolation backbone)_

- **Objective**: a tenant can exist, be scoped to companies/branches, and be
  administered; no data path bypasses the guard pipeline.
- **Modules**: platform, identity, access, org, secrets (vault shell). **DB**:
  plans/versions/defaults; tenant/entitlement/limit; user/credential/mfa/session/refresh;
  role/permission/grant/scope; company/trade_license/branch/branch_setting/pos_terminal;
  RLS on all; partitioning declared.
- **Backend**: auth (login, refresh rotation + reuse detection, logout, MFA,
  step-up), the full guard pipeline, policy engine, permission-preview API,
  LimitService, entitlement resolution, tenant provisioning, impersonation.
- **Frontend**: Super Admin Web — tenant lifecycle, plan/entitlement/limit/override
  editors, tenant users + roles + scope, sessions, audit viewer, impersonation.
  Tenant login + "my access" screen.
- **Security**: Argon2id, brute-force, session revocation, platform realm separation
  - hardware MFA + IP allowlist, RLS backstop verified, secret redaction filter.
- **Tests**: policy truth tables, auth e2e, limit enforcement. **Isolation**:
  cross-tenant probe suite v1 over every endpoint; RLS bypass attempts.
- **Exit**: tenant B cannot touch tenant A by any manipulation; limits block at the
  boundary; revoke ends access in seconds; probe suite green; every route has an
  explicit permission decorator.

## Phase 2 — Devices, realtime core, outbox, audit, localization/money, documents, notifications _(cross-cutting infra)_

- **Objective**: the shared machinery every domain relies on, including the branch
  realtime pipeline.
- **Modules**: devices, realtime, audit, localization, documents, notifications (+
  WhatsApp share), outbox dispatcher, idempotency store.
- **DB**: pos_device/policy/activation_code; audit_log (hash chain) + security_event;
  countries/currencies/vat/locales/translation/holidays; document + version +
  extraction(null); notification_template/log + wa_share_template; outbox +
  idempotency_key; realtime resume tokens.
- **Backend**: device activation + device-bound sessions + management; Money + UOM
  libraries; document upload→quarantine→AV→promote→signed download; notification
  abstraction (email/SMS) + SMS OTP; WA share link; outbox → Redis Stream publisher.
- **Realtime**: topic model, subscription authorization, resume-from-seq,
  dedup/reorder handling, gateway consumer group; a demo `ping` event proves
  reconnect semantics. Resolve the `seq`-granularity + stale-position questions in
  [`../phase-2/REALTIME-PROTOCOL-INPUTS.md`](../phase-2/REALTIME-PROTOCOL-INPUTS.md)
  (ultra-review F8/F9) as part of this.
- **Security**: WebCrypto keypair activation + DPoP proof; AV + magic-byte +
  signed-URL proxy; audit tamper-evidence job.
- **Exit**: device lifecycle complete; documents reusable by any owner_type;
  realtime proven under fault injection; outbox proven.

## Phase 3 — Catalog, tax, orders, POS walk-in sale, payments, double-entry GL, receivables _(first revenue path + financial truth)_

- **Objective**: a florist rings up a STOCKED walk-in sale with correct GCC tax,
  cash + one card provider; every sale posts one balanced, idempotent journal entry;
  other branch terminals see it live.
- **Modules**: catalog, identifiers, pricing (basic), tax, orders, payments,
  **accounting** (CoA + posting engine + periods), **receivables** (AR / credit /
  advances / gift cards), crm (core), files, reporting (first rollups).
- **ADR-0018 (additive, 2026-09-05)**: `catalog` also designs the
  `business_type_template` reference table + tenant catalog capability
  configuration (extends §48; Super-Admin write, Owner operate-within) and must
  resolve the per-selling-UOM pricing gap (`variant_uom_price` or equivalent)
  before the `pricing` module's schema is frozen — see
  [`../decisions/ADR-0018.md`](../decisions/ADR-0018.md). No change to this
  phase's dependency order or exit criteria; this is scope detail within the
  already-planned `catalog`/`pricing` modules, not new modules.
- **ADR-0019 (additive, 2026-09-05, amended twice same day)**: `receivables`/
  `payments`/`accounting` also design, as **core Phase 3 scope, not deferred**:
  the invoice payment-status state machine (incl. PAID vs SETTLED), customer
  settlement with deterministic AUTO-FIFO default allocation, the
  manual-allocation and settlement-discount toggles (incl. their approval/audit
  paths and the AUTO+discount server recalculation), the settlement-screen UI
  contract, the extended customer-ledger entry-kind taxonomy, and — Part B —
  the full cancellation/refund/customer-account-credit/cancellation-charge
  architecture: six independent lifecycle states, cancellation monetary
  resolution (refund/account-credit/split) validated against actual money
  received, line-level partial cancellation, a configurable cancellation-charge
  policy engine with audited override, settled-invoice cancellation, and the
  cancellation-screen UX contract — see
  [`../decisions/ADR-0019.md`](../decisions/ADR-0019.md). Only the _statutory_
  reporting depth this feeds (financial statements, VAT-return export,
  multi-currency consolidation) stays in Phase 10, unchanged. No change to this
  phase's dependency order or exit criteria; a credit-capable receivables system
  cannot ship without its own cancellation/collection/settlement workflow, so
  this is not new scope creep, only concrete detail on already-planned modules.
- **Backend**: price + tax resolution; order state machine (walk-in) + gapless
  numbering; the atomic POS sale (order + payment allocation + **synchronous journal
  posting** + audit via outbox); the posting engine + core posting templates;
  default CoA seeding on tenant provisioning; payments provider port + 1 adapter +
  webhooks; refund + step-up. _COGS/inventory-value postings are stubbed until
  Phase 5._
- **Realtime**: `order.created/updated/status_changed`, `payment.updated` on the
  branch topic; POS renders a live transaction feed.
- **Tests**: money math (incl. 3-decimal), tax per country, numbering gaplessness
  under concurrency, idempotent sale, webhook dedup. **Financial**: every posting
  balances; `(source_kind,source_id)` uniqueness blocks double-post; credit ≠ cash;
  advance received ≠ revenue, applied nets; split/partial totals; refund reverses
  revenue + VAT. **Concurrency**: parallel sales → no duplicate/gapped numbers, no
  double journal entry. **Isolation**: branch + tenant isolation of orders,
  payments, journal lines.
- **Exit**: a full cash/card/credit/advance walk-in sale posts correct, balanced GL
  entries; trial balance ties; Owner figures reconcile to the GL and to source
  transactions.

## Phase 4 — Cash register, POS shift, X-Report, Z-Report, expenses, other income _(POS financial control)_

- **Objective**: every POS terminal runs a controlled register session — open
  float, cash-movement ledger, expected vs counted cash, over/short, an interim
  X-Report, and a finalized immutable Z-Report. Branch/POS-permitted expenses and
  manual income are captured and posted.
- **Modules**: **cash-register**, **expenses**. **Dependencies**: Phase 3.
- **DB**: `cash_register` + `register_session` + `cash_movement` (partitioned,
  append-only) + `x_report_log` + `z_report` + `z_report_line` (immutable,
  hash-chained, gapless `z_number`) + `post_close_adjustment`; `expense_category` +
  `expense` + `other_income`; rpt_cash_register_daily + rpt_over_short +
  rpt_expense_daily + rpt_income_daily.
- **Backend**: open/close session with overlap policy; cash-movement writes for each
  type, source-referenced; expected-cash computation; count entry → over/short →
  **central X/Z formula module**; close sequence (freeze snapshot + hash → post
  over/short + float-return + safe-drop journal entries → session CLOSED → emit
  event); post-close correction path (reversing entry + adjustment note, original Z
  untouched); expense workflow (create → approve → pay → post); manual other-income
  posting.
- **Tests**: expected cash = float + Σ movements; counted cash + over/short posting;
  X-Report does not close; **Z-Report formulas** (central, unit-tested); **Z
  immutability** — editing an order after close does not change its finalized Z;
  gapless `z_number` under concurrency; **register isolation** — POS-01 cash
  movements/sessions invisible to POS-02; cash expense hits the drawer _and_ the Z;
  expense/purchase-payment not double-counted; posting balance invariants; idempotent
  close. **Isolation**: branch + tenant + register.
- **Exit**: a full shift opens, transacts (cash/card sales, a cash refund, a cash
  expense, a safe drop), closes with a counted-cash variance requiring approval, and
  produces an immutable Z-Report whose figures tie to the GL and the cash-movement
  ledger.

## Phase 5 — Raw-material inventory, movement ledger, reservations, barcode receiving, wastage, COGS _(stock & cost truth)_

- **Objective**: branch stock is a movement ledger with reservations and wastage;
  quick barcode receiving works; inventory value and COGS post to the GL.
- **Modules**: inventory (full), procurement (basic). **DB**: inventory_item
  (+kinds) + uom + uom_conversion + lot; inventory_movement (partitioned) +
  branch_inventory_balance + stock_reservation + stock_count(+lines) + reorder_rule
  - wastage_event; supplier + supplier_balance + purchase(+lines) +
    goods_receipt(+lines) + supplier_bill; rpt_stock_valuation_snapshot +
    rpt_wastage_daily + rpt_purchase_daily + rpt_supplier_balance.
- **Backend**: transactional movements for every category; per-(branch,item)
  locking; `AvailabilityService`; reservation lifecycle + scheduler; barcode
  receiving + pack conversion + unknown-code workflow; conditioning wastage;
  weighted-average valuation; **inventory↔GL postings in the same transaction**;
  STOCKED sale now runs reservation→consumption→COGS; Inventory-control-account
  reconciliation job.
- **Realtime**: `inventory.changed`, `inventory.reservation_changed`.
- **Tests**: ledger consistency under concurrent sale + adjustment; reservation vs
  adjustment race; valuation + FEFO; idempotent receiving (no double stock, no
  double GRNI); **inventory/accounting integration** — receipt/consumption/wastage
  move quantity _and_ value atomically; Inventory control account = Σ branch
  balances; purchase vs payment not double-counted. **Concurrency suite** hardened.
- **Exit**: no oversell path exists; balances reconcile to the ledger and the GL;
  gross profit (Net Revenue − COGS) is now a supported figure.
- **ADR-0018 (additive)**: batch/expiry tracking (already Z-11 for raw flowers)
  generalizes to any `inventory_item.kind` — same fields, same mechanism, no new
  schema beyond confirming it is not flower-specific.
- **ADR-0019 Part B (additive, 2026-09-05)**: cancellation-driven inventory
  disposition (reservation release, `CUSTOMER_RETURN` restocking) reuses this
  phase's existing movement engine and categories unchanged — no new inventory
  mechanism; disposition is decided from physical state, never from a
  cancellation-charge amount — see
  [`../decisions/ADR-0019.md`](../decisions/ADR-0019.md) §29/§30.

## Phase 6 — Recipes/BOM, custom bouquet builder, production / work orders _(florist core)_

- **Objective**: sell predefined BOM bouquets and build custom bouquets; component
  reservation + consumption + florist attribution + costing are traceable.
- **Modules**: recipe, production. **DB**: recipe(+version) + recipe_component;
  custom_bouquet + custom_bouquet_component (snapshots); work_order +
  work_order_consumption + work_order_output + assignment.
- **Backend**: recipe explosion → atomic multi-component reservation; custom-bouquet
  capture + snapshot + pricing rule + margin-approval; work-order completion →
  MATERIAL_CONSUMPTION movements + reservation→consumed + cost roll-up +
  PRODUCTION_OUTPUT + the matching `Dr COGS / Cr Inventory` journal entry.
- **Tests**: explosion correctness (×N, wastage factor); partial BOM availability →
  nothing reserved; custom-bouquet snapshot survives item deletion; concurrent BOM
  sales → atomic reservation; cost roll-up = Σ component consumption cost; COGS
  posting matches consumption value.
- **Exit**: a BOM sale and a custom bouquet both consume the right materials
  transactionally with florist attribution, correct cost, and a correct COGS posting.
- **ADR-0018 (additive)**: this phase's `custom_bouquet` mechanism is confirmed
  generic (a hamper, gift box, or bundle uses the identical mechanism); new schema
  here uses the vertical-neutral name `custom_composition` /
  `composition_component`. Custom composition/bundle gains its own §48-style
  capability toggle alongside the existing `Production / BOM` module — see
  [`../decisions/ADR-0018.md`](../decisions/ADR-0018.md).
- **ADR-0019 Part B (additive, 2026-09-05)**: cancelling a BOM/custom-composition
  order after production does not automatically un-consume raw materials — this
  phase's `MATERIAL_CONSUMPTION`/`PRODUCTION_OUTPUT` movements stay as recorded;
  cancellation disposition of the finished item/reusable components
  (`RETURN_TO_STOCK` / `WASTAGE` / `SPOILAGE` / `SCRAP` / etc.) is a new
  decision layered on this phase's existing consumption model, not a change to
  it — see [`../decisions/ADR-0019.md`](../decisions/ADR-0019.md) §29.

## Phase 7 — Customer Web storefront, online orders queue, delivery, realtime fan-out _(second channel)_

- **Objective**: a tenant-branded storefront takes paid online orders that appear
  instantly in the correct branch's POS queue and share the same inventory rules.
- **Modules**: storefront, fulfilment. **DB**: storefront_config + tenant_domain
  (verified) + cms + published_catalog_item + promo/coupon (basic);
  delivery_zone/charge/time_slot/slot_capacity/delivery/driver_assignment/delivery_event/proof_of_delivery;
  online_order_queue projection.
- **Backend**: host→tenant resolution; published-catalog projection; storefront anon
  API bound to `AvailabilityService` + reservation (soft hold on checkout, reserve
  on payment); channel policy (accept/reject, payment-before-confirm); delivery
  assignment + status + POD.
- **Realtime**: `online_order.created`, `order.status_changed`, `delivery.updated`
  to the fulfilling branch.
- **Tests**: tenant-routing + per-tenant cache-key isolation; checkout + payment
  e2e; slot-capacity race; soft-hold expiry; realtime delivery of a new order to the
  right branch only. **Isolation**: storefront + customer realm probe suite.
- **Exit**: a web order paid online lands in the correct branch queue within ~2s,
  reserves stock through the shared engine, and never bleeds to another tenant/branch.

## Phase 8 — Workforce, schedule, leave, attendance, attribution, commission _(full workforce in POS)_

- **Objective**: the complete workforce module inside POS + Owner Web; attendance
  from POS and the ingest API; performance/commission from real attribution.
- **Modules**: workforce, attendance, commissions. **DB**: staff + employment +
  staff_assignment + position + shift + schedule + leave_request; attendance_device
  - staff_device_mapping + attendance_event (partitioned) + attendance_session +
    attendance_correction; commission_rule/target/tip + staff_performance_daily +
    rpt_florist_output_daily + rpt_attendance_daily.
- **Backend**: `/v1/me/*` self-service; POS punch (POS_WEB, offline Class A); ingest
  API (signed, idempotent, unmapped parking, normalization); session pairing + shift
  matching + exceptions; correction workflow + approval; commission calc job; order
  attribution rollups.
- **Tests**: self-scope (staff A cannot see staff B); idempotent ingest (duplicate
  external_event_id → one record); offline punch replay; timezone/offset; correction
  audit; commission math incl. refund reversal. **Isolation**: branch-isolation for
  workforce.
- **Exit**: POS and the ingest API produce one unified attendance record set;
  commission is trustworthy; a manager outside a branch cannot see or correct its
  attendance.

## Phase 9 — AI WhatsApp, Customer Web AI, shared tool layer _(required AI modules)_

- **Objective**: both AI channels live on one secure tool layer; AI orders enter the
  central domain and reach the right branch live.
- **Modules**: ai, whatsapp. **DB**: ai_conversation + ai_message + ai_tool_call +
  ai_handoff; wa_integration (secret ref) + wa inbound log.
- **Backend**: `AiProvider` port; `AiOrchestrator` + fixed `ToolRegistry` (10 tools)
  with server-bound tenant/branch/customer context, value caps,
  confirmation-for-money, per-conversation/customer/tenant rate limits, full
  tool-call audit; WhatsApp BSP webhook (signature) + routing + session windows;
  Customer Web chat widget backend.
- **Security tests**: prompt-injection / tool-abuse suite; context-binding (model
  cannot widen scope); confirmation-required; no tool returns secrets or
  cross-tenant data; rate-limit + cost caps.
- **Exit**: an AI-created order clears confirmation, is paid before fulfilment,
  lands in the right branch queue, and the red-team suite passes.

## Phase 10 — Hardening: financial reporting depth, DR drills, biometric adapter pilot, e-invoicing, promotions/loyalty/subscriptions _(production-grade)_

- **Objective**: operational + financial maturity and the regulated / deferred
  integrations, each behind its own gate.
- **Work**: full `rpt_*` set + materialized views + read-replica routing + async
  exports; **advanced accounting** — statutory-style financial statements, VAT-return
  export, multi-currency consolidation, optional branch business-day close, optional
  external accounting-package sync (class C/D); one biometric vendor adapter pilot
  (FACE/FINGERPRINT/RFID) against the ingest API; KSA ZATCA / UAE e-invoicing
  adapter _if approved_ (Z-8); promotions/coupons engine, loyalty + gift-card
  redemption, subscription generator, event/wedding workflow UI; OCR
  purchase-invoice extraction (if approved); full pen-test + DR game-day measuring
  RPO/RTO.
- **Exit**: financial reports + trial balance + management P&L reconcile to the GL
  within tolerance; a full restore meets RPO ≤ 5 min / RTO ≤ 2 h; a real biometric
  device posts attendance end-to-end; regulated integrations pass conformance
  sandboxes.
