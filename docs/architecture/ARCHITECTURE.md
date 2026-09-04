# Flower SaaS — Architecture (frozen, approved v0.4)

> **Status:** APPROVED 2026-09-03. This is the specification of record. It is the
> Markdown rendering of architecture proposal v0.4
> (artifact `cc5dfdf5-4ee5-4083-8045-5d2594e2628b`). Supersedes v0.1–v0.3.
> All 23 decisions (Z-1…Z-14, ZF-1…ZF-9) are approved — see
> [`../decisions/DECISION-LOG.md`](../decisions/DECISION-LOG.md).
> Where the **V3 requirements revision** and the original Master Prompt conflict,
> **V3 governs**.
>
> SVG figures in the source artifact are rendered here as prose descriptions.
> The financial design follows standard double-entry practice; it is an internal
> management ledger, **not** a certified accounting product. Regulatory and
> library-version references are directional — confirm current mandates before use.

---

## 0. What Flower SaaS is

A multi-tenant florist commerce SaaS for the GCC (UAE, KSA, Qatar, Kuwait, Bahrain,
Oman). A **modular monolith**: one TypeScript monorepo, one deployable image run in
four runtime roles (`api`, `worker`, `scheduler`, `realtime`), four user-facing web
apps, PostgreSQL 17 + Redis + S3-compatible object storage. NestJS backend,
Next.js frontends, Prisma, BullMQ. No microservices, no Kubernetes.

### Invalidated assumptions from v0.1 (V3 changes)

- **Five apps → four.** No Staff Mobile App, no scaffold. `apps/staff-mobile` is
  deleted from the plan. Workforce is delivered entirely inside the POS PWA.
- **Warehouse domain → removed.** No `stock_location`, no `warehouse_branch_link`.
  Inventory balances are keyed directly by `branch_id`. Branch-to-branch transfers
  remain (`TRANSFER_IN/OUT` movement types) but there is no warehouse entity.
- **Owner Web "primarily dashboards" → full tenant-wide business management**, first
  class, spanning every company and branch, bounded only by platform security,
  entitlement, permission and Super Admin controls.
- **Realtime gateway "open decision" → hard requirement.** A specified event model +
  reconnection semantics are core, built early.
- **AI WhatsApp "deferred, separate approval" → required core module**, alongside a
  required Customer Web AI chatbot, both on one shared secure tool/orchestration
  layer.
- **Payment / integration credentials → Platform Super Admin only.** No tenant-realm
  user may enter, view, edit or rotate any raw external secret.
- **POS scope as a first-class isolation axis → demoted.** Branch is the operational
  data boundary. POS terminal id is identity / origin / cash-session / audit /
  reporting only. Same-branch terminals are not isolated from each other.
- **Staff ≈ user → hard separation.** A staff member can exist with no login.
- **Recipe/BOM + custom bouquet + reservation → core early phases**, not late polish.
- **KSA ZATCA e-invoicing → adapter port now, implementation a later phase** (Z-8),
  with KSA onboarding gated on it.

### Carried over unchanged from v0.1

- Modular monolith, one codebase, `api`/`worker`/`scheduler`/`realtime` entrypoints.
- Backend is the sole authoritative business-logic layer.
- Four identity realms; short-lived access token + server-side session (revocation
  in seconds) + rotating refresh + device-bound signing key for registered POS.
- Money as integer minor units + currency + exponent (KWD/BHD/OMR 3-decimal).
- Application-layer scoping + PostgreSQL RLS backstop + automated cross-tenant &
  cross-branch probe suite in CI.
- Transactional outbox as the backbone for events, integrations, reporting, audit.
- Generic documents/attachments domain on private S3 with a quarantine + AV pipeline.

---

## R. Risk analysis

### R.1 Contradictions resolved (brief ↔ V3, and within V3)

| Contradiction                                                                                               | Resolution                                                                                                                                                                                                                           |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Original "Staff App required" vs V3 "no Staff App"                                                          | Workforce backend built in full (required inside POS). `/v1/me/*` self-service still built; only consumer is the POS PWA.                                                                                                            |
| Original warehouses vs V3 branch-based inventory                                                            | Warehouse concept dropped. A future central store is modelled as a branch with restricted selling. Architecture-ready, not built.                                                                                                    |
| Owner manages users vs Super Admin manages users                                                            | Layered: Super Admin authoritative over all tenant users/roles/permissions/entitlements/limits; Owner + permitted admins manage **normal business users** within entitlements/limits, never platform roles / limits / secrets (Z-2). |
| AI WhatsApp creates orders vs WhatsApp key is Super-Admin-only                                              | Super Admin configures BSP/AI credentials per tenant (and per branch if the merchant differs). Owner toggles the module + non-secret behaviour. The AI never sees a raw secret.                                                      |
| "cart must not consume stock" vs "scheduled/online orders require reservation" vs "be conservative offline" | Explicit inventory lifecycle per order type (§22). Cart = availability check + optional soft-hold. Reservation on confirm. Consumption on production/completion. No inventory/reservation write offline.                             |
| "don't reduce fictional bouquet stock" vs "finished products exist"                                         | Every variant declares `fulfilment_strategy`: `STOCKED` / `BOM` / `CUSTOM`. One catalog, three defined behaviours.                                                                                                                   |

### R.2 Missing flower-business requirements (now addressed)

Perishability (`lot` carries `received_at` + optional `expiry_at` +
`expected_life_days`; FEFO option; aging-stock report; spoilage-suggestion job) ·
gifting model (buyer ≠ recipient, recipient address book, card message, hide-price,
anonymous sender) · substitution policy (per-order flag + policy) · peak-day
capacity (delivery-slot + production ceilings per branch per day, pre-order
cut-offs) · standing/subscription orders (architecture-ready) · conditioning loss on
receiving (immediate conditioning-wastage entry).

### R.3 GCC risks

- **KSA ZATCA Phase 2 e-invoicing is live and near-universal** — by mid-2026 the
  threshold reaches SAR 375k turnover (effectively every real florist). Onboarding a
  KSA tenant without the Fatoora clearance adapter is a compliance gap (Z-8).
- **3-decimal currencies** (KWD, BHD, OMR) — handled by the money model; a
  2-decimal assumption anywhere is a defect.
- **VAT divergence** — UAE 5%, KSA 15%, Bahrain 10%, Oman 5%, Qatar & Kuwait none.
  The tax engine models "no VAT" cleanly, not a 0% hack. Arabic mandatory on tax
  invoices; RTL invoice/receipt layout.
- **Data residency** — KSA PDPL / cloud rules may require in-country hosting for
  some data; UAE PDPL. Code is region-agnostic (`tenant.region`); launch region is
  Z-3.
- **WhatsApp BSP** availability, sender-ID / template approval, per-country rules
  vary across the GCC. AI WhatsApp go-live depends on a BSP relationship.
- **Calendar** — Hijri display, Ramadan hours, prayer-time closures, Fri–Sat vs
  Sat–Sun weekends — affect attendance shift logic and delivery slots.
- **Trade-license / CR expiry** tracking per company, with reminders; VAT/TRN on
  every invoice.

### R.4 Security risks

| Risk                                                                                                               | Answer                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Realtime subscription authorization — joining `branch:{id}` topics is a new path to cross-tenant/cross-branch data | Every subscribe re-runs the guard pipeline (tenant + branch scope + session status); topics are server-assigned from the session, never client input; token refresh re-authorizes; session revocation drops sockets immediately.                                                                                             |
| AI tool layer — an untrusted conversation calls `createOrder` / `createPaymentLink`                                | Fixed tool allowlist; tenant + branch + customer context bound server-side from the conversation, never from model output; value caps; explicit customer confirmation before order/payment; no tool returns secrets or cross-tenant rows; every tool call audited; per-conversation / per-customer / per-tenant rate limits. |
| Prompt injection via product data, customer messages, WhatsApp display names                                       | Structured tool I/O only; system-prompt isolation; tool inputs validated as if hostile; model outputs treated as data, not instructions; a red-team suite in CI.                                                                                                                                                             |
| Super-Admin-only secrets concentrate blast radius on the platform console                                          | Separate deployment + auth realm, hardware MFA, IP allowlist, dual-control for credential writes, break-glass runbook, dedicated audit stream.                                                                                                                                                                               |
| Custom-bouquet builder — POS user picks arbitrary components, quantities, price                                    | Permission-gated (`pos:custom_bouquet`); component cost + selling price snapshotted; margin-below-threshold requires approval; full audit.                                                                                                                                                                                   |
| Unknown-barcode "create item" at receiving → catalogue pollution                                                   | Permission-gated; new items land in a review state; audited; duplicate-value guard per tenant.                                                                                                                                                                                                                               |
| Document-id enumeration                                                                                            | UUID v7 ids, ownership + scope check on every access, signed short-TTL URLs via a download proxy, no direct bucket exposure.                                                                                                                                                                                                 |
| Multi-role privilege union                                                                                         | Explicit deny grants (deny wins); step-up MFA for money / permission / secret actions; permission-preview review before save.                                                                                                                                                                                                |

### R.5 Inventory & concurrency risks

Oversell under concurrent sales → every stock-affecting write takes a row lock on
the `branch_inventory_balance` row (`SELECT … FOR UPDATE`) or a Postgres advisory
lock keyed by `hash(branch_id, item_id)`; movement + balance update commit in one
transaction; availability re-checked inside the lock; client cache never trusted at
confirm. Reservation ↔ adjustment race → same lock domain, serialized per (branch,
item); an un-honourable reservation is surfaced, not silently dropped. Partial BOM
availability → atomic across all components; partial failure returns which component
blocked it; nothing reserved. Balance projection drift → scheduled reconciliation
recomputes from the ledger and alerts; the ledger is the truth. Retried writes →
`Idempotency-Key` on every stock/financial write + a dedup table. Realtime staleness
→ the authoritative re-check at confirm prevents the oversell.

### R.6 PWA limitations (stated honestly)

- A browser cannot read MAC addresses or reliably fingerprint hardware. Device
  identity is a server-issued credential + a non-extractable WebCrypto key — strong
  against credential copying, not against a fully compromised OS.
- **iOS installed-PWA push is unreliable** for background delivery. Online-order
  alerts arrive via WebSocket while the POS is open; background push on iOS is
  best-effort. Recommend an always-on "orders" screen / dedicated terminal.
- Background Sync API is limited on iOS/Safari — the offline queue flushes on next
  foreground, not guaranteed in background.
- Camera barcode scanning is slower / less reliable than a HID scanner. Recommend
  HID scanners for receiving; camera as fallback.
- Local thermal printing / cash-drawer kick needs a local hardware bridge (later).
  Browser printing + PDF receipts now.
- Browser storage can be evicted → device may need re-activation; the flow handles it.

### R.7 Biometric hardware / integration limitations

Vendor SDKs / protocols differ (ZKTeco, Hikvision, Suprema, …). LAN devices need an
on-prem connector agent; cloud-attendance platforms push via webhook; both terminate
at one signed ingest API. Biometric matching and enrolment stay **vendor-side** —
Flower SaaS stores no raw fingerprint/face templates (PDPL: biometrics are sensitive
data); it stores external user ref → staff mapping, event, timestamp, method, device,
branch, event id. Device clock drift → events carry device timestamp + server
receipt time; large drift is flagged. Face-recognition accuracy / liveness are the
vendor's responsibility. Offline buffering is vendor-dependent; the ingest API is
idempotent so replay-on-reconnect is safe. No vendor selected yet — a reference
"Manual / API" connector is built now.

### R.8 AI security & product risks

Hallucinated price/availability → the model never states a price or stock figure
from its own knowledge; every such value comes from a tool call against the branch's
authoritative data. Order repudiation → explicit in-conversation confirmation stored
verbatim; payment before fulfilment for AI orders by default; full audit. Cross-
tenant leakage → the conversation is bound to one tenant (usually one branch) at
creation; tools cannot widen scope. Cost / DoS → token caps per turn and per
conversation, message-rate limits, abuse detection, auto handoff / cool-down. PII in
transcripts → retention policy, card/ID redaction, access gated by
`ai:conversations:view`. Provider lock-in → an `AiProvider` port; orchestration +
tool layer are provider-agnostic.

### R.9 Payment risks

Operational friction from Super-Admin-only branch-level credentials → onboarding
checklist, bulk/templated config screen, clear "provider not configured for this
branch" states. Webhook duplication/replay → signature + timestamp window +
idempotency on the provider event id. Partial refund → VAT recomputed on the
refunded portion, not pro-rated naively. 3-decimal rounding in split/partial
payments → all arithmetic in the money value object with explicit rounding +
residual-allocation rules. Provider outage/retry → explicit `PENDING` state; a
reconciliation job resolves stragglers; retries idempotent. PCI scope → hosted
fields / redirect only; the platform never receives a PAN.

---

## 1. Application architecture

Four user-facing apps, one backend codebase with four runtime roles. No Staff App,
no separate business-admin app. Branch administration and the full workforce live
inside the POS PWA, gated by permission.

**Layers:** user-facing apps → Edge (CDN · WAF · TLS · rate limit · dynamic CORS ·
REST `/v1` + WebSocket) → Core (one codebase: `api` REST `/v1`, `worker` BullMQ,
`scheduler` cron, `realtime` WebSocket/SSE gateway; ~31 domain modules; adapter
ports: payment · whatsapp/AI · attendance-device · storage · notifications ·
e-invoicing future; transactional outbox → event bus + queues + realtime +
reporting) → State (PostgreSQL 17 authoritative · RLS · replica; Redis cache /
sessions / queues / streams; Object storage: private · quarantine · CDN images).

| App                    | Primary users                                                         | Default scope                                                         | Notable surfaces                                                                                                                                                                                                                                    |
| ---------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Super Admin Web**    | Platform staff                                                        | All tenants (platform realm)                                          | tenants, plans, entitlements, limits, tenant users/roles, sessions/devices, **all external secrets**, security events, audit, monitoring                                                                                                            |
| **Owner Web**          | Owners, tenant admins                                                 | Whole tenant — every company & branch                                 | full business management (catalog, pricing, inventory, BOM, purchases, customers, orders, delivery, staff, attendance, schedules, leave, commissions), tenant-wide reporting, Customer Web + AI non-secret settings                                 |
| **POS PWA**            | Cashiers, sales, florists, storekeepers, supervisors, branch managers | The acting branch (multi-branch only if explicitly assigned)          | _Sell_ (cart, custom bouquet, payments, receipts, hold/resume, drawer), _Manage_ (products, inventory, receiving, wastage, purchases, online-orders queue, staff, attendance, schedule, leave, branch reports), _My workspace_ (self-service staff) |
| **Customer Web / PWA** | Shoppers                                                              | One tenant (resolved from host), branch resolved by address/selection | browse, variants, custom bouquet (if allowed), cart, checkout, pickup/delivery/scheduled, online payment, tracking, account, order history, **AI chatbot**                                                                                          |

Owner Web and the POS "Manage" surface consume the same REST API and share
`packages/ui` feature components. They differ only in default data scope. "AI
WhatsApp" and "Customer Web AI chatbot" are a module and a channel — not apps.

---

## 2. Monorepo structure

pnpm workspaces + Turborepo. Authoritative business logic lives only in `apps/api`;
shared packages hold contracts, constants and pure utilities, enforced by ESLint
boundary rules.

| path                       | what it is                                                                                                                                                                                          |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/api`                 | NestJS — REST `/v1`, all ~31 domain modules, the only place business rules live                                                                                                                     |
| `apps/worker`              | NestJS bootstrap running BullMQ processors; imports the same domain modules                                                                                                                         |
| `apps/scheduler`           | cron / repeatable jobs (reconciliation, rollups, reminders, reservation expiry, session reaping)                                                                                                    |
| `apps/realtime`            | WebSocket / SSE gateway; consumes Redis Streams, authorizes branch topics                                                                                                                           |
| `apps/super-admin-web`     | Next.js — deployed separately, own auth realm                                                                                                                                                       |
| `apps/owner-web`           | Next.js — tenant-wide management, mobile-friendly                                                                                                                                                   |
| `apps/pos-pwa`             | Next.js PWA — _Sell_ / _Manage_ / _My workspace_ route groups, code-split, permission-gated                                                                                                         |
| `apps/customer-web`        | Next.js — multi-tenant storefront, SSR/ISR, custom domains, embedded AI chat widget                                                                                                                 |
| `packages/shared-types`    | DTOs, enums, zod schemas — contracts shared FE/BE, no logic                                                                                                                                         |
| `packages/permissions`     | permission-key constants + types                                                                                                                                                                    |
| `packages/api-client`      | typed REST client generated from OpenAPI                                                                                                                                                            |
| `packages/realtime-client` | WebSocket client: subscribe, resume-from-seq, dedup, reconnect/backoff                                                                                                                              |
| `packages/money`           | currency table + exponents, minor-unit math, formatting — pure                                                                                                                                      |
| `packages/uom`             | unit-of-measure families + conversion math, fractional-safe — pure                                                                                                                                  |
| `packages/i18n`            | message catalogs, locale + RTL helpers, CLDR wiring                                                                                                                                                 |
| `packages/ui`              | shared React design system (Tailwind + headless primitives) + business feature components shared by Owner Web and POS Manage                                                                        |
| `packages/testing`         | Testcontainers helpers, the tenant + branch isolation probe harness, concurrency-test utilities, fixtures                                                                                           |
| `packages/config`          | eslint (flat) + boundary rules, tsconfig bases, tailwind preset                                                                                                                                     |
| `packages/db`              | Prisma schema + generated client + migrations + seed; shared by `api`, `worker`, `scheduler` (**refinement**: schema lives here, not `infra/db`, so all three share one client + migration history) |
| `infra/`                   | docker-compose (dev), Dockerfiles, Terraform                                                                                                                                                        |
| `tooling/`                 | scripts, `spikes/rls`                                                                                                                                                                               |

---

## 3. Backend / domain modules (~31)

Each is a NestJS module with its own service layer and tables. Modules interact
through service interfaces and domain events, never by touching another module's
repositories (lint-enforced). RLS + `ScopedRepository` apply everywhere.

| Module          | Owns                                                                                                                                                                                                                                          |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `platform`      | tenants, status, plans + versions, entitlements, limit overrides, platform users & roles, impersonation, platform audit, monitoring                                                                                                           |
| `identity`      | users, credentials, MFA, sessions, refresh tokens, login security events                                                                                                                                                                      |
| `access`        | roles, permission registry, direct grants/denies, data-scope assignments, the policy engine, permission preview                                                                                                                               |
| `org`           | companies / legal entities / trade licenses (+ expiry), branches, branch settings, POS terminals                                                                                                                                              |
| `devices`       | POS device registry, activation codes, device keypairs, device sessions, device policies                                                                                                                                                      |
| `secrets`       | external-credential vault (payment / WhatsApp / AI / SMS) — **Super Admin write only**, KMS envelope encryption, rotation, dedicated audit                                                                                                    |
| `localization`  | countries, currencies + exponents, VAT / tax config, locales, translations, timezones, holiday calendars                                                                                                                                      |
| `catalog`       | products, product types, categories, attribute defs, variants + options, fulfilment strategy, price lists, branch price, media                                                                                                                |
| `identifiers`   | barcodes / QR / SKU registry, pack conversions, unknown-code workflow                                                                                                                                                                         |
| `inventory`     | inventory items (raw material / packaging / finished / consumable), UOM + conversions, lots, the movement ledger, branch balances, reservations, counts, reorder rules                                                                        |
| `recipe`        | predefined BOM / recipes + versions + components                                                                                                                                                                                              |
| `production`    | work orders, florist assignment, component consumption, output, costing, production wastage, custom-bouquet composition snapshots                                                                                                             |
| `procurement`   | suppliers, supplier balances (AP), purchase orders, receiving / GRN, supplier bills, payments, credit notes, returns                                                                                                                          |
| `pricing`       | price resolution, promotions / coupons, discount policy, custom-bouquet pricing rules                                                                                                                                                         |
| `tax`           | per-country / per-company tax config, calculation, gapless fiscal numbering, e-invoicing port                                                                                                                                                 |
| `orders`        | the order aggregate: channel, kind, lines, snapshots, state machine, holds, quotations, subscriptions, gifting fields, staff attribution                                                                                                      |
| `payments`      | payment intents, transactions, split/partial allocations, refunds, provider port + adapters, webhooks, provider/bank settlement reconciliation                                                                                                |
| `accounting`    | **new** — chart of accounts, double-entry journal + lines, the event→posting engine, accounting periods + soft-close, trial balance, financial statements, source-event idempotency. One GL per company, dimensioned by branch / POS / shift. |
| `receivables`   | **was `ledger`** — customer AR subledger, credit limits, customer advances, gift cards, statements. Reconciles to the AR / Advances control accounts in `accounting`.                                                                         |
| `cash-register` | **new** — cash registers (POS-terminal-scoped), register sessions / POS shifts, the append-only cash-movement ledger, X-Report, Z-Report (+ immutable snapshot), safe drops, optional branch business-day close                               |
| `expenses`      | **new** — expense entries + configurable expense categories/accounts, approval workflow, expense payment, other / manual income; receipts via `documents`                                                                                     |
| `crm`           | customers, contacts, addresses, recipients (gifting), groups, notes, communication consent, loyalty                                                                                                                                           |
| `fulfilment`    | delivery zones, charges, time slots + capacity, pickup, driver assignment, dispatch board, tracking, proof of delivery, reschedule                                                                                                            |
| `storefront`    | tenant storefront config, verified domains, branding, CMS, published-catalog projection, slot & min-order config, custom-bouquet options                                                                                                      |
| `workforce`     | staff profiles, employment, branch assignment, positions (non-authz), schedules / shifts, leave                                                                                                                                               |
| `attendance`    | attendance events (all sources), corrections + approvals, attendance-device registry, staff-device mapping, the ingest API                                                                                                                    |
| `commissions`   | commission / incentive rules, targets, tips, staff-sales & florist-output rollups                                                                                                                                                             |
| `ai`            | AI provider port, the shared tool registry + orchestrator, conversations, messages, tool-call audit, human handoff — used by both WhatsApp AI and Customer Web AI                                                                             |
| `whatsapp`      | WhatsApp BSP integration (inbound webhook, session windows, templates), routing inbound messages to `ai` or to human agents                                                                                                                   |
| `notifications` | templates, channels, provider adapters (email / SMS / push), delivery status; the WhatsApp _share-link_ builder                                                                                                                               |
| `documents`     | generic attachments: owner_type/id, doc types, versions, storage keys, AV scan status, signed-URL issuance                                                                                                                                    |
| `audit`         | append-only audit log (per-tenant hash chain), security-event aggregation, query API                                                                                                                                                          |
| `reporting`     | summary / rollup tables, report queries, async exports, reporting-currency snapshots                                                                                                                                                          |
| `realtime`      | outbox → stream publisher, topic model, subscription authorization, resume tokens                                                                                                                                                             |
| `files`         | public product-image pipeline (resize, CDN) — separate from private `documents`                                                                                                                                                               |

---

## 4–5. Hierarchy, entity ownership & scope matrix

No warehouse. Branch is the operational boundary. Every tenant-owned row carries
`tenant_id`; operational rows also carry `company_id` and `branch_id`. IDs are
UUID v7.

**Hierarchy:** Platform → Tenant (isolation root) → { Owner/tenant user (tenant
level) · Company (trade license) · Business user / staff (branch-scoped by default) }
→ Branch (operational boundary) → POS terminal(s) (identity / origin / audit only).

| Entity                                            | Owned by                              | Default read scope for a business user                                  | Realtime topic                    |
| ------------------------------------------------- | ------------------------------------- | ----------------------------------------------------------------------- | --------------------------------- |
| Company, Branch, POS terminal, POS device         | tenant / company                      | assigned branches; Owner = tenant-wide                                  | —                                 |
| Product, variant, category, price list            | tenant (catalog is tenant-wide)       | tenant-wide read; branch price & availability per branch                | `tenant:{t}:catalog`              |
| Inventory item / material, UOM                    | tenant (definition), branch (balance) | tenant-wide definitions; balances for assigned branches                 | `tenant:{t}:branch:{b}:inventory` |
| Inventory movement, balance, reservation, wastage | branch                                | assigned branches only                                                  | `…:branch:{b}:inventory`          |
| Order, order line, payment, delivery              | branch                                | assigned branches only                                                  | `…:branch:{b}:orders`             |
| Customer, address, recipient, ledger              | tenant                                | tenant-wide (customers shop at any branch); credit actions permissioned | `tenant:{t}:customer`             |
| Staff, schedule, leave, attendance                | branch (home branch)                  | own record always; branch staff with `staff:view`; Owner tenant-wide    | `…:branch:{b}:workforce`          |
| Supplier, purchase, GRN                           | tenant or company                     | per permission + company scope                                          | `…:branch:{b}:procurement`        |
| AI conversation                                   | tenant (+ branch once resolved)       | `ai:conversations:view` + branch scope                                  | `…:branch:{b}:ai`                 |
| Document / attachment                             | inherits its owner entity             | inherits owner's scope; signed URL per access                           | —                                 |
| Audit log, security event                         | tenant                                | Owner / admin per permission; Super Admin all                           | —                                 |

**Four distinct counts / limits:** POS account/user count (users who can sign into
POS) · POS terminal count (`pos_terminal` rows) · registered device count (active
`pos_device` rows) · concurrent session count (live sessions in Redis, per user /
per POS terminal / per Owner pool). Four separate mechanisms (§43).

---

## 6–7. Owner authorization model & branch-user model

**Owner** — a tenant-level `user` with `account_type = OWNER` and the seeded Owner
role + tenant-wide data scope (`company: ALL`, `branch: ALL`). Full authorized
tenant-wide business access across all companies and branches. Bounded by: platform
security, subscription entitlements (a disabled module is invisible),
permission/policy (a deny grant can still block a specific action), and Super Admin
controls (suspension, limits, forced settings). **Cannot**: access another tenant,
obtain/create a Platform Super Admin role, bypass entitlements or limits, or
read/write any raw external secret. `account_type = OWNER` is a limit bucket, never
an authorization signal.

**Branch user** — default scope = exactly one branch (where they were created).
Multi-branch is **explicit** (named branch grants; no implicit "all branches in the
company"). Company-level visibility (a regional manager over 4 branches) = a branch
grant listing those 4, optionally with a per-branch permission overlay ("manage in
Dubai, view in Sharjah"). The guard pipeline resolves the target resource's
`branch_id` and checks it against the user's grants; list endpoints inject the
branch filter.

---

## 8. User vs Staff (non-negotiable V3 rule)

Two separate entities with an optional link.

| `user` — the login account                                                                                        | `staff` — the employment profile                                                                                                                         |
| ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Authentication + application access. Belongs to a tenant.                                                         | An employee record. Belongs to a tenant + a home `branch`.                                                                                               |
| Has: credentials, MFA, roles, permission grants, data scope, `account_type`, status (ACTIVE / DISABLED / LOCKED). | Has: staff code, name, phone/email, photo, hire date, employment type, job title, department, notes, status (ACTIVE / INACTIVE / ON_LEAVE / TERMINATED). |
| Disabling a user ends their sessions and access — and touches nothing else.                                       | `staff.user_id` is **nullable** — a florist who never logs in still exists, gets scheduled, gets attributed sales, and punches via a biometric device.   |

Transactions record both `acting_user_id` (who was authenticated) and one or more
`staff_id` attributions. Terminating a staff member sets status = TERMINATED and
end-dates assignments; all historical rows keep pointing at the `staff_id`. Nothing
is deleted. Linking works both directions (POS login for an existing florist; a user
with no staff profile, e.g. a remote accountant).

---

## 9. Roles, permissions & data scopes

Four independent axes checked on every protected request: **entitlement** ·
**permission** · **data scope** · **business rule**. A job title is never any of them.

- **Permission** — a key `domain:action[:qualifier]` from a central, versioned,
  code-defined registry. A user may hold **multiple roles**; effective permissions =
  (∪ role permissions ∪ direct grants − direct denies), filtered by entitlement,
  intersected with the permissions valid for the target's resolved scope.
- **Role** — a named permission bundle. System roles seeded per tenant (Owner,
  Admin, Manager, Supervisor, Cashier, Sales, Florist, Storekeeper, Purchase Staff,
  Accountant, Dispatcher, Driver, Receptionist); tenant custom roles allowed.
  Multi-role users: _Cashier + Sales_, _Florist + Sales_, _Manager + Cashier_.
- **Data scope** — separate assignment: `company` (ids or ALL), `branch` (ids or
  ALL), optionally a per-branch permission overlay. POS scope only where a feature
  genuinely needs it (cash session, device binding).
- **Deny wins.** Step-up MFA gates money, permission, secret and attribution-change
  actions.

### Permission catalogue (representative — refined during design)

- **POS sell:** `pos:sell · pos:discount · pos:price_override · pos:refund · pos:void · pos:reprint · pos:change_staff · pos:custom_bouquet · pos:drawer:open · pos:drawer:close · pos:zreport`
- **Orders:** `orders:view · orders:manage · orders:cancel · orders:attribution:edit · online_orders:view · online_orders:manage · online_orders:accept · online_orders:reject`
- **Catalog / pricing:** `catalog:view · catalog:manage · variants:manage · pricing:manage · branch_price:manage · promotions:manage`
- **Inventory:** `inventory:view · inventory:receive · inventory:adjust · inventory:transfer · inventory:count · inventory:wastage · inventory:reservation:view · recipe:view · recipe:manage · identifiers:manage`
- **Procurement:** `purchases:view · purchases:manage · purchases:receive · suppliers:manage · supplier_payments:manage`
- **Staff / workforce:** `staff:view · staff:create · staff:edit · staff:disable · staff:branch_assign · staff:schedule:view · staff:schedule:manage · staff:attendance:view · staff:attendance:manage · staff:attendance:correct · staff:leave:view · staff:leave:manage · staff:leave:approve · staff:performance:view · staff:commission:view · staff:commission:manage · attendance_device:manage`
- **Customers / credit:** `customers:view · customers:manage · credit:view · credit:manage · advance:manage · giftcards:manage · payments:refund:approve · reports:view · reports:tenant`
- **Accounts & finance:** `accounts:view · accounts:manage · income:view · income:create · income:edit · income:approve · expense:view · expense:create · expense:edit · expense:approve · expense:pay · financial_reports:view`
- **Cash register / shift:** `cash_register:open · cash_register:view · cash_register:cash_in · cash_register:cash_out · cash_register:close · cash_register:override · x_report:view · x_report:print · z_report:view · z_report:close · z_report:print`
- **Customer Web / AI:** `customer_web:view · customer_web:manage · customer_web:catalog:manage · customer_web:slots:manage · ai:settings:view · ai:settings:manage · ai:conversations:view · ai:conversations:reply · ai:handoff:handle`
- **Admin:** `users:view · users:manage · roles:manage · devices:activate · devices:manage · audit:view · settings:branch:manage · settings:tenant:manage`

Secrets have **no** tenant-side permission key at all — the capability does not
exist in the tenant realm.

---

## 10 & 12. Super Admin administration

The platform control plane. Separate deployment, separate identity realm, hardware
MFA, IP allowlist, dual-control for the most dangerous actions.

- **Tenant lifecycle & commerce:** create / suspend / resume / terminate tenants;
  provisioning (seed roles, permissions, country config, first company + branch +
  POS); companies / branches / POS terminals / registered devices; plans, plan
  versions, module entitlements, every numeric limit (§43) + per-tenant overrides
  with mandatory reason + audit; impersonation (time-boxed, reason-tagged,
  permission-reduced, banner + dedicated audit stream, optional tenant opt-in).
- **Users, security & secrets:** tenant users (view/create/edit/disable, assign
  roles + company/branch scope, view effective permissions, revoke sessions, reset
  MFA); Platform Super Admin roles are a wholly separate set, never grantable to /
  held by a tenant user; **all external API secrets** created/edited/rotated/revoked
  here only, per tenant / company / branch, KMS-encrypted, masked, never logged,
  never returned to any tenant-realm API; security events, active sessions, device
  revocation, audit logs, platform monitoring.

---

## 11. POS PWA architecture

Installable PWA, online-first, three internal route groups (each code-split and
independently permission-gated):

- **Sell** — fast, keyboard-first; works during brief network loss for Class A/B only.
- **Manage** — products, inventory, receiving, wastage, purchases, online-order
  queue, staff, attendance, schedule, leave, branch reports, branch settings.
- **My workspace** — self-service staff: profile, punch, attendance, schedule,
  leave, my sales, my performance, my commission, notifications.

**Install:** web app manifest, `display: standalone`, maskable icons; Edge/Chrome on
Windows & Android, Safari on iPad. **Service worker (Workbox):** precache the hashed
app shell; runtime-cache _reference_ data only (catalog snapshot, price lists, tax
config, effective permissions, branch staff list) with `stale-while-revalidate` and
a visible "as of HH:MM" marker. Mutable API responses are never cached as
authoritative. **Updates:** waiting SW + "new version — reload"; the API sends
`min-supported-client` → below it, a blocking upgrade screen; staged rollout per
tenant. **Realtime:** on load, opens a WebSocket to `realtime`, subscribes to the
acting branch's topics. **Scanning:** HID keyboard-wedge scanners need no code;
`BarcodeDetector` + bundled fallback for camera. **Printing:** `window.print()` +
receipt stylesheet + server PDF receipt; thermal / drawer kick via a local hardware
bridge later, behind a `PeripheralService` abstraction shipped now. **Storage:**
IndexedDB for the reference cache, offline action queue, device key handle, realtime
resume tokens; `localStorage` for non-sensitive UI prefs only.

---

## 12. POS registered-device architecture

Device identity is a server-issued, revocable credential bound to a non-extractable
key. Never IP, MAC, fingerprint, or a plain LocalStorage id.

1. An authorized user (`devices:activate`, step-up MFA if policy requires) creates
   POS terminal(s) under a branch and generates a **one-time activation code** —
   short, single-use, ~15-min TTL, rate-limited, bound to (tenant, company, branch,
   terminal).
2. On the new install: enter the code (+ user login / MFA per policy). The PWA
   generates a non-extractable ECDSA/Ed25519 keypair (WebCrypto) and sends the
   _public_ key + code to `POST /v1/devices/activate`.
3. Server validates & consumes the code, creates the `pos_device` row (public key,
   status ACTIVE, activated_by/at/ip, terminal binding), writes audit + security
   event, returns a device credential bundle that proves device identity during
   login/refresh only — it grants no data access by itself.
4. Every later login on that device: user authenticates _and_ the device signs a
   server challenge → the session is bound to `device_id` and the terminal.
5. **Management** (Super Admin + authorized Owner): list · last seen · session
   history · security events; actions: activate, revoke (kills sessions, blocks
   key), block (temporary), replace (revoke + new code). Lost browser storage →
   device shows "stale" → re-activation with a new code.
6. **Policies** (Super Admin per tenant; branch override): `registered_device_required`,
   `max_registered_devices`, `max_pos_concurrent_sessions`, `max_sessions_per_user`,
   `browser_pos_allowed`, `who_can_activate`, `activation_requires_mfa`.

Browser (unregistered) POS, where allowed, is a separate axis governed by
`browser_pos_allowed`, counted against concurrent-session limits, possibly
feature-restricted, never in the device registry.

---

## 13–14. Same-branch realtime & event reconciliation

All authorized POS terminals in a branch, plus that branch's slice of Customer Web
operations, operate on the same authoritative branch data and see each other's
changes within ~1–2 seconds. Realtime is an accelerator; the backend is the source
of truth.

**Pipeline** (refined in [ADR-0017](../decisions/ADR-0017.md), 2026-09-04):
PostgreSQL (write + outbox in 1 txn) → outbox dispatch (`SKIP LOCKED` poll;
assigns `seq` once, persists it before publish) → **durable Redis Stream per
tenant** (`rt:stream:{tenantId}`, ≈ 24h time-based retention — _not_ a `MAXLEN`
guarantee) → **realtime relay** (one logical consumer of the stream) → **Redis
Pub/Sub** (`rt:live:{tenantId}` — live multi-gateway fanout) → every realtime
gateway instance → POS-01/02/03 + Owner/manager clients. A gateway **consumer
group is not the socket-broadcast path** (a consumer group would split events
across instances). Live delivery is **at-least-once**; duplicates are suppressed
by `event_id`. **Resume/replay always reads the durable Stream**; the client's
resume cursor is a **scanned Redis Stream entry ID** (advanced by the gateway
across every stream entry it reads on the client's behalf, incl. other-branch /
filtered-out entries — so unrelated tenant activity never strands a
subset-subscribed client). On reconnect it replays from that cursor; resync
**only** if the cursor is below the stream's retained floor. No `seq` arithmetic
is ever a resync trigger (F8).

**Event model:** every event carries
`{ event_id, seq (per tenant, monotonic — a logical ordering / diagnostic value,
not the resume cursor), tenant_id, branch_id, type, resource_type, resource_id,
resource_version, occurred_at, actor_summary }`. `event_id` and `seq` are assigned
**once** and are immutable — a crash-induced re-publish carries the identical
values. Payload is a small summary; the client refetches the resource for full
detail. Types:
`order.created · order.updated · order.status_changed · payment.updated ·
customer.updated · inventory.changed · inventory.reservation_changed ·
online_order.created · production.updated · staff.updated · attendance.updated ·
delivery.updated` (extensible). Source: the transactional outbox.

**Subscription authorization:** the client connects with its access token; the
gateway resolves the session → tenant + branch scope, and only lets it subscribe to
`tenant:{t}:branch:{b}:*` topics it is authorized for. Topics are derived
server-side. On token refresh the subscription set is re-evaluated; on session
revocation the socket closes immediately (Redis pub/sub to all gateway instances).

| Concern                    | Handling                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reconnect / missed events  | The client stores a **scanned Redis Stream cursor** — the entry id the gateway has consumed on its behalf, advanced across **every** stream entry incl. other-branch / filtered-out ones. On reconnect the gateway replays from that cursor (`XRANGE`, payload filtered to authorized topics). Resync **only** if the cursor is below the stream's retained floor (≈ 24h time-based) → full REST resync, then cursor = current stream tail. **No arithmetic `seq`-distance resync trigger** — not per-topic, not tenant high-water (F8 — [ADR-0017](../decisions/ADR-0017.md)). |
| Duplicates                 | `event_id`; the client reducer is idempotent (apply-once by id). Live Pub/Sub delivery is at-least-once, so dedup is mandatory.                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Out-of-order               | Each event carries `resource_version`; the client applies an update only if newer, else refetches. The **scanned cursor advances for every consumed event** — including `stale`/`duplicate`/not-for-me (fixes F9) — so a stale event never feeds a false gap.                                                                                                                                                                                                                                                                                                                   |
| Stale client state         | The heartbeat carries the current stream tail id + the scanned cursor + an **informational** tenant `seq` high-water. Resync eligibility is scanned-cursor vs the retained stream range — **never** `tenantHighWaterSeq − clientLastSeq`. Unrelated branch activity advances the scanned cursor (gateway scans past it), so a subset-subscribed client is never stranded. On tab focus after sleep → compare the scanned cursor to the retained range.                                                                                                                          |
| Server restart             | Gateway instances are stateless; events live in the outbox + Redis Stream; the relay resumes from its consumer-group offset. `seq`/`event_id` immutability makes a re-publish after a dispatcher crash safe (identical values).                                                                                                                                                                                                                                                                                                                                                 |
| Multiple backend instances | The relay's own consumer group scales the stream→Pub/Sub step; every gateway instance `SUBSCRIBE`s to the Pub/Sub channel, so all instances get every event. The outbox dispatcher runs as a single active leader per tenant (advisory lock) so `seq` is strictly increasing. Publish is **at-least-once; effect is effectively-once** (idempotent consumers keyed on `event_id`).                                                                                                                                                                                              |

Transport: WebSocket (SSE fallback for restrictive networks). `packages/realtime-client`
encapsulates subscribe / resume / dedup / backoff so all four apps behave identically.

---

## 15 · 17 · 18 · 19. Products, variants, units, barcodes & receiving

**Product & variant model.** `product` — the sellable concept (flowers, bouquets,
arrangements, plants, gifts, add-ons, packaging-as-product, custom). Has
`product_type`, category, media, attributes, and a **`fulfilment_strategy`**:
`STOCKED` · `BOM` · `CUSTOM`. `variant` — a concrete sellable SKU generated from
**option groups + values** (Size, Colour, Style, Occasion…); never hardcoded
columns. Each variant may carry own SKU, barcode(s), QR, base price, per-branch
price (when `branch_price` is enabled), per-branch availability flag, images,
attribute overrides. `STOCKED` variant → links to a `FINISHED_GOOD` inventory item;
`BOM` variant → links to a `recipe`; `CUSTOM` product → no fixed variant,
composition captured at sale.

**Units of measure.** `uom` catalogue (stem, piece, bunch, sheet, roll, meter,
centimetre, box, pack, gram, kilogram… extensible per tenant). `uom_conversion`:
within a family (meter↔centimetre) globally; item-specific conversions (1 bunch
Baby's Breath ≈ 10 stems) on the item; pack conversions (1 carton = 12 pieces) on
the barcode identifier. **Fractional quantities** where the UOM permits — quantities
are `NUMERIC(18,4)`; ribbon = 1.5 m, foam = 0.25 block. `packages/uom` does
conversion math and enforces per-UOM decimal rules (you cannot sell 1.5 gift boxes).
Each inventory item has a **base UOM**; the movement ledger always stores base-UOM
quantities; the UI converts for display/entry.

**Barcode / QR architecture.** `item_identifier(id, tenant_id, target_kind: VARIANT
| INVENTORY_ITEM, target_id, code_type: BARCODE | QR | SKU, value, pack_uom?,
pack_qty?, status)`. Unique on `(tenant_id, code_type, value)`. A variant or
material can have several identifiers; scanning any resolves to the same target.
`pack_qty` + `pack_uom` drive pack conversion at receiving. QR encodes internal
labels (bouquet ticket, shelf label) and can carry a variant/lot reference.

**Barcode inventory receiving.** POS _Manage → Quick Stock In_: scan → resolve
item/variant → show current branch on-hand → enter quantity (pack conversion
applied) → cost (if policy requires) → optional supplier / purchase reference →
optional lot / expiry → confirm. Confirm creates a `PURCHASE_RECEIPT` or `STOCK_IN`
`inventory_movement` (idempotency-keyed), updates the branch balance in the same
transaction, emits `inventory.changed`. **Unknown barcode**: an authorized user
links it to an existing item or creates a new item through a guided workflow; the
new item lands in a `DRAFT`/review state; audited. Supports HID scanners
(recommended for volume) + camera. Retrying the same receive does not double-count.

---

## 16 · 20 · 21. Raw-material inventory, movement ledger & concurrency

**Raw materials are first-class.** `inventory_item(id, tenant_id, kind, name,
base_uom_id, is_lot_tracked, is_expiry_tracked, default_cost, reorder_level?, …)`.
`kind`: `RAW_MATERIAL` (Red Rose, Lily, greenery), `PACKAGING` (wrapping sheet,
ribbon, foam, basket, vase, gift box, greeting card), `FINISHED_GOOD` (a pre-made
stocked bouquet), `CONSUMABLE`. Per item: optional SKU + barcode/QR, base UOM,
branch stock, cost, supplier link(s), reorder level, movement history, wastage,
optional lot/batch (`lot` with `received_at`, optional `expiry_at`,
`expected_life_days`, `unit_cost`). Materials and finished goods share the same
ledger and balance tables — one inventory engine.

**Movement ledger & balances.** Never overwrite a quantity. Every change is an
`inventory_movement(id, tenant_id, branch_id, item_id, lot_id?, category, qty_base
(signed), unit_cost?, ref_kind, ref_id, reservation_id?, acting_user_id, staff_id?,
occurred_at, idempotency_key)` — append-only. Categories: `PURCHASE_RECEIPT ·
STOCK_IN · SALE · MATERIAL_CONSUMPTION · PRODUCTION_OUTPUT · CUSTOMER_RETURN ·
SUPPLIER_RETURN · ADJUSTMENT_IN · ADJUSTMENT_OUT · WASTAGE · SPOILAGE · TRANSFER_IN ·
TRANSFER_OUT`. Reservations live in their own table with `RESERVE` / `RELEASE` /
`CONSUME` transitions, not as stock movements. `branch_inventory_balance(tenant_id,
branch_id, item_id, on_hand_base, reserved_base, available_base GENERATED, avg_cost,
version, updated_at)` — a projection of the ledger + open reservations, updated
transactionally and periodically reconciled. Valuation: weighted-average by default;
FEFO lot selection for expiry-tracked items; a valuation snapshot table for
reporting.

**Concurrency.** Every stock-affecting operation runs in one DB transaction that
first **locks the balance row** for `(branch_id, item_id)` (`SELECT … FOR UPDATE`),
or takes an advisory lock keyed by `hash(branch_id, item_id)` when many items move
together (a BOM sale) to keep a stable lock order and avoid deadlocks. Inside the
lock: check availability → write the movement / reservation → update the balance
(`version` bump) → commit → emit the event. **`Idempotency-Key`** required on every
stock and financial write; a dedup table returns the original result on retry. The
client's cached/realtime availability is advisory only. A nightly job recomputes
balances from the ledger and alerts on drift.

---

## 22. Stock reservation architecture

One authoritative availability model shared by POS, Customer Web, AI WhatsApp and
Customer Web AI. Adding to a cart never consumes or hard-reserves stock.

**Lifecycle:** Cart (availability check) → Soft hold (optional, TTL 10m) →
Reservation (on order confirm) → Consumption (on production/complete) → Movement
ledger (SALE / CONSUMPTION). cancel / expire → RELEASE; partial prep → partial
CONSUME, remainder stays reserved.

| Order type                   | Cart                                                           | Confirm                                                   | Consume                                  |
| ---------------------------- | -------------------------------------------------------------- | --------------------------------------------------------- | ---------------------------------------- |
| Walk-in / immediate POS      | availability check only                                        | reserve (instantaneous)                                   | on sale completion — usually same second |
| POS pickup / delivery today  | availability check                                             | reserve on order confirm                                  | on production / hand-off                 |
| Scheduled order (POS or Web) | availability check for the target date                         | reserve for the fulfilment date on confirm + payment rule | on production day                        |
| Customer Web / AI order      | availability check + optional 10-min soft hold during checkout | reserve on payment success (or on accept, per policy)     | on production                            |
| Event / wedding              | quote; no hold                                                 | reserve on deposit + confirmed date                       | on production                            |
| Custom bouquet               | availability check per selected component                      | reserve components on order confirm                       | on florist completion                    |

**Model:** `stock_reservation(id, tenant_id, branch_id, item_id, lot_id?, qty_base,
source_kind (ORDER_LINE | WORK_ORDER | SOFT_HOLD), source_id, status (HELD |
PARTIALLY_CONSUMED | CONSUMED | RELEASED | EXPIRED), fulfilment_date?, expires_at?,
created_at)`. `balance.reserved_base` = Σ open (HELD + PARTIALLY_CONSUMED)
reservations; `available` = `on_hand − reserved`. Future-date availability nets
same-date reservations against projected receipts. Created on confirm; decremented
on consumption; released on cancel / reject / payment failure; expired by the
scheduler for soft holds and unpaid orders past their hold window. Cancellation
always releases (a state transition + an event, never a silent delete). A downward
stock adjustment that would make reservations un-honourable does not delete them —
it flags an "over-reserved" exception for a manager. No double reservation / oversell
(the per-(branch,item) lock; BOM/custom reservation atomic across components). The
single `AvailabilityService` is the only path any channel uses.

---

## 23 · 24 · 25 · 26. Recipes/BOM, custom bouquets, production & wastage

**Predefined bouquet recipe / BOM.** `recipe(id, tenant_id, variant_id, version,
yield_qty, effective_from, status)` + `recipe_component(recipe_id, item_id, qty_base,
uom_id, wastage_factor?)`. Selling/producing _N_ of a `BOM` variant explodes the
recipe: required = component.qty × N × (1 + wastage_factor). The system
reserves/consumes the **components**; it does **not** decrement a fictional
finished-bouquet stock for a BOM variant. Recipe versioning: historical orders
reference the recipe version in force at order time.

**Custom bouquet builder.** In POS _Sell_ (`pos:custom_bouquet`) a florist picks
components + quantities + UOM. The order line points at a `custom_bouquet` aggregate

- `custom_bouquet_component` rows. **Everything is snapshotted** — component names,
  quantities, UOM, unit cost, selling price — so the historical bouquet stays legible
  even if items/prices change or items are deleted. Pricing: configurable —
  component-cost-plus-margin by default, with a permissioned manual override; a margin
  below a tenant threshold requires approval (audited). Components reserved on order
  confirm, consumed on florist completion, like a BOM.

**Production & material consumption.** `work_order(id, tenant_id, branch_id,
order_id, order_line_id?, kind (BOM | CUSTOM), status (PENDING | IN_PROGRESS | DONE
| CANCELLED), assigned_florist_staff_id?, started_at, completed_at)`. On completion
the work order creates transactional `MATERIAL_CONSUMPTION` movements per component,
moves the reservation to CONSUMED, optionally records a `PRODUCTION_OUTPUT` movement,
and rolls up actual cost — one transaction, then `inventory.changed` +
`production.updated`. Florist assignment feeds performance/commission (§33).

**Wastage / spoilage.** `wastage_event(id, tenant_id, branch_id, item_id, lot_id?,
qty_base, uom_id, reason (SPOILAGE | DAMAGE | EXPIRY | CONDITIONING | SHRINKAGE |
OTHER), staff_id?, acting_user_id, cost_impact, notes, document_id?, occurred_at)` →
a `WASTAGE` / `SPOILAGE` movement. On-hand and available reflect it immediately;
cost impact posts to the ledger. The received-goods flow offers an immediate
conditioning-wastage entry. Optional photo/document via `documents`. Fully audited.

---

## 27–30. Staff management, schedule, leave & attendance

Full workforce module, inside POS (and Owner Web tenant-wide). Staff are
branch-based; normal staff see only their own sensitive data.

- **Staff management.** `staff` fields: staff code, name, phone/email, photo, hire
  date, employment type, job title, department/category, notes; status `ACTIVE /
INACTIVE / ON_LEAVE / TERMINATED`; home `branch_id`; nullable `user_id`. Branch
  managers/admins manage their branch's staff; Owner manages tenant-wide.
  Termination end-dates assignments and preserves all history.
- **POS _My workspace_** exposes, per permission: My Profile · Punch In/Out · Break
  Start/End · My Attendance + history · My Schedule / Shift · My Leave + Apply +
  status · Assigned Work/Orders · My Sales · My Performance · My
  Commission/Incentive · Notifications. A normal staff member never sees another
  employee's attendance, pay, performance or leave detail.
- **Schedule / shift.** `shift` (named: Morning 08–16, Split…) with start/end +
  break windows. `schedule(staff_id, branch_id, effective_from, effective_to?,
pattern)` with working days, per-day times, assigned shift. History retained;
  conflict validation at save; GCC calendar awareness (weekend model, Ramadan
  hours, public holidays from `localization`).
- **Leave.** `leave_type` (annual, sick, unpaid…) with tenant-config rules.
  `leave_request(staff_id, type, date_range, reason?, status (PENDING | APPROVED |
REJECTED | CANCELLED), approver_user_id, decided_at)`. `staff:leave:approve` gates
  decisions; every decision audited; an approved leave flips staff status to
  `ON_LEAVE` for the period and feeds schedule + attendance exception logic.
- **Attendance.** Events: `CLOCK_IN · CLOCK_OUT · BREAK_START · BREAK_END`.
  `attendance_event(id, tenant_id, branch_id, staff_id, type, occurred_at,
server_received_at, source, device_id?, acting_user_id?, shift_id?,
verification_method?, external_event_id?, status)`. Sources: `POS_WEB ·
BIOMETRIC_DEVICE · RFID_DEVICE · MANUAL · API`. POS punches use `POS_WEB` and may
  queue offline (Class A). Events pair into `attendance_session`s, match against the
  scheduled shift, raise exceptions (late, missing punch, over-break).
  **Corrections**: `attendance_correction` is a new event referencing the original +
  reason + approver (`staff:attendance:correct`); the original is never deleted.
  `attendance.updated` pushes to authorised manager screens in real time.

---

## 31. Face / fingerprint / RFID connector architecture

Biometric matching and templates stay on the vendor/device side. Flower SaaS
receives only mapping + event data through one signed, idempotent ingest API.
Hardware never touches PostgreSQL.

**Flow:** Device (matches enrolled staff) → Connector (on-prem agent / cloud
webhook) → Attendance Ingest API (signed · idempotent) → Staff mapping (external
ref → staff_id) → Event (+ branch realtime).

- `attendance_device(id, tenant_id, branch_id, vendor, methods [FACE | FINGERPRINT |
RFID], serial, credential_ref, status (ACTIVE | BLOCKED | REVOKED), last_sync_at,
last_event_at)`.
- `staff_device_mapping(attendance_device_id, external_user_ref, staff_id)` — the
  only identity link stored. **No raw fingerprint or face templates** in core
  storage (PDPL: biometrics are sensitive data).
- Ingest `POST /v1/attendance/ingest`: connector auth via HMAC-signed body or
  keypair, per-device rate limit. Payload: list of `{ external_user_ref,
raw_event_type, device_timestamp, external_event_id, verification_method }`.
- **Idempotency**: unique `(device_id, external_event_id)`; plus a fuzzy
  `(device_id, external_user_ref, timestamp, type)` window for connector retries.
- **Unmapped events** are parked for a manager to resolve — never dropped, never
  guessed.
- Normalization: per-device rules map raw codes to `CLOCK_IN/OUT`, `BREAK_START/END`.
- A reference "Manual / API" connector is built now; ZKTeco / Hikvision / Suprema
  adapters follow hardware selection. Entitlements gate the feature.

---

## 32 · 33. Transaction staff attribution & performance / commission

**Attribution.** The order records `created_by_user_id` / `acting_user_id`
(authenticated identity — **never** overwritten) plus `order_staff_attribution(order_id,
role_key, staff_id, set_by_user_id, set_at)` — many rows: `SALESPERSON · FLORIST ·
CASHIER · APPROVER · DRIVER`. A fast **Staff Picker** in POS; no logout between
customers; selected staff must be `ACTIVE` and valid for the branch. A branch/tenant
setting decides whether salesperson selection is mandatory per sale. Post-completion
changes need `orders:attribution:edit` + audit (before/after, reason).

**Performance & commission.** Rollups are computed from attribution + order +
production + refund events (via the outbox), not from the logged-in user: sales by
staff, orders by staff, salesperson revenue, florist output, AOV, targets,
commission, incentives, and the effect of refunds/cancellations. `commission_rule`
(rate / tier / product-group / channel), `commission_target`, `tip`,
`staff_performance_daily`. Refund/cancellation reverses the relevant attribution's
contribution. Commission calc is a scheduled job with a manual-recalc option;
recalculations are audited.

---

## 34 · 35 · 36. Central order domain, Customer Web & online orders

**One order domain.** A single `order` aggregate. Dimensions: `channel` (`POS ·
CUSTOMER_WEB · WHATSAPP_AI · CUSTOMER_WEB_AI · PHONE · MANUAL · MARKETPLACE:*`
future), `kind` (`WALK_IN · PICKUP · DELIVERY · SCHEDULED · EVENT ·
SUBSCRIPTION_INSTANCE · QUOTATION`), `origin_branch_id`, `fulfilling_branch_id`,
`company_id`, `tenant_id`. Gifting fields: `recipient_id?`, `card_message?`,
`hide_price`, `substitution_policy`. Lines reference a variant, a `recipe`
explosion, or a `custom_bouquet`; add-ons are child lines; price + tax + discount
are snapshotted. State machine (per kind): `DRAFT/HELD → PLACED → CONFIRMED →
IN_PRODUCTION → READY → OUT_FOR_DELIVERY / AWAITING_PICKUP → COMPLETED/DELIVERED` +
`REJECTED · CANCELLED · PAYMENT_FAILED · REFUNDED · DELIVERY_FAILED · RESCHEDULED`.
**All channels use the same** availability, reservation, production, tax, pricing,
numbering and ledger logic — Customer Web / AI orders are only a different channel
value + a channel policy object (e.g. WEB requires payment before CONFIRMED and an
accept/reject step). Gapless numbering per (company, series, year) allocated at
PLACED / invoice issue.

**Customer Web / PWA.** Multi-tenant Next.js storefront; tenant resolved from host
(custom domain → platform subdomain → path fallback), 404 on unknown host, no
cross-tenant fallback. Per tenant: branding, CMS, published catalog, custom-bouquet
options (if policy allows), delivery zones/charges, slot capacity + min order.
Branch routing: the delivery address's zone (or an explicit pickup-branch choice)
resolves the fulfilling branch → drives availability, pricing, slots. Checkout:
guest (phone OTP) or account; recipient ≠ buyer; card message; hide-price; delivery
date + slot with live capacity; online payment via the branch's
Super-Admin-configured provider. Order created with `channel = CUSTOMER_WEB` → lands
in the fulfilling branch's Online Orders queue → `online_order.created` pushed live.
Isolation: storefront tokens are anon-scoped; customer identity realm is per-tenant;
ISR/CDN cache keys include the host; per-tenant cache-key tests in CI.

**Online orders in POS.** A dedicated _Digital / Online Orders_ area — never mixed
into the walk-in transaction list. A read-model queue over orders where `channel ∈
{CUSTOMER_WEB, WHATSAPP_AI, CUSTOMER_WEB_AI, PHONE}`. Lifecycle: `NEW →
ACCEPTED/CONFIRMED → PREPARING → READY → PICKUP/OUT_FOR_DELIVERY →
DELIVERED/COMPLETED` + rejected · cancelled · payment failed · refunded · delivery
failed · rescheduled. Status changes emit `order.status_changed`.

---

## 37 · 38 · 39. AI WhatsApp, Customer Web chatbot & the shared tool layer

Both AI channels are required modules. They share one secure orchestration + tool
layer. The AI never has direct database access and never holds a raw secret.

**Shared AI orchestration & tool layer.** `AiProvider` port (provider-agnostic);
credentials Super-Admin-only in `secrets`. `AiOrchestrator` runs the conversation
loop against a **fixed tool registry**. Every tool is a thin wrapper over an
existing domain service, executed under a constrained service identity carrying
`{ tenant_id, branch_id?, customer_id?/session, channel }` — **always taken from the
bound conversation context, never from model output.** Tools: `searchProducts ·
getProductDetails · checkAvailability · resolveBranch · calculateDelivery ·
createCart · createOrder · getOrderStatus · createPaymentLink ·
requestHumanHandoff`. Each tool call validates tenant + branch + customer/session +
authorization + inputs; enforces value caps; is rate-limited; is audited
(`ai_tool_call`). `createOrder` / `createPaymentLink`: require an explicit
in-conversation customer confirmation (stored verbatim); prices come only from tool
results; payment-before-fulfilment by default; optional human approval per tenant.
Guardrails: prompt-injection defenses (structured I/O, system-prompt isolation,
hostile-input validation), token caps, abuse detection, safe-data-exposure rules,
telemetry + audit, human handoff. Entities: `ai_conversation(id, tenant_id, channel
(WHATSAPP_AI | CUSTOMER_WEB_AI), customer_id?, branch_id?, status,
assigned_user_id?)`, `ai_message(conversation_id, role, content, tool_calls,
created_at)`, `ai_handoff(conversation_id, reason, to_user_id?, at)`.

**AI WhatsApp.** `whatsapp` integrates a BSP (Business API). Inbound → webhook
(signature-verified) → routed to `AiOrchestrator` or a human agent per state. Orders
enter the central order domain with `channel = WHATSAPP_AI`. Entitlement: `AI
WhatsApp`. Owner toggles behaviour (non-secret); Super Admin holds the BSP
credentials.

**Customer Web AI chatbot.** An embedded widget in `customer-web`; reuses the same
orchestrator + tools with `channel = CUSTOMER_WEB_AI` and strict tenant/branch
context from the storefront host + session. Entitlement: `Customer Web AI`.

**Normal WhatsApp share** (kept entirely separate, in `notifications`; no WhatsApp
Business API): `GET /v1/whatsapp-share/link?type=INVOICE&orderId=…` resolves a
configured template and returns a `wa.me` URL; the human presses Send. No shared
runtime with the AI module.

---

## 40 · 41. Purchases, suppliers, receiving & document attachments

**Purchasing.** `supplier`, `supplier_balance` (AP), optional `purchase_order` +
lines, `purchase` / supplier bill + lines, `goods_receipt` + lines,
`supplier_payment`, `supplier_credit_note`, `purchase_return`, purchase history.
Receiving generates `PURCHASE_RECEIPT` inventory movements (branch-scoped)
transactionally; supplier AP posts to the ledger. **No duplicate receiving**: a
receipt is keyed to its purchase line + an idempotency key; re-submitting is a
no-op. Barcode receiving (§19) can create receipts directly without a formal PO.

**Documents / attachments.** Generic `documents` domain — not purchase-specific.
`document(owner_type, owner_id, doc_type_key, status, …)` + `document_version(storage_key,
mime, size, checksum, scan_status, …)`. `owner_type` is an open string
(`PURCHASE_BILL, SUPPLIER, EXPENSE, CUSTOMER, PRODUCT, ORDER, DELIVERY, STAFF,
COMPANY, WASTAGE_EVENT, …`). Formats: PDF, JPG/JPEG, PNG (+ HEIC→convert). Multiple
attachments; mobile camera upload; desktop drag-drop; preview; authorized download;
archive/delete per permission; notes; document type; audit. **Large binaries never
in PostgreSQL.** Flow: `upload-intent` (authorize + validate declared
mime/ext/size) → pre-signed PUT to a private _quarantine_ bucket → `complete` → job:
magic-byte sniff vs declared, AV scan (ClamAV), PDF structure check, image re-encode
→ CLEAN → promote to the durable private bucket; INFECTED → quarantined + notify.
Access: permission + scope check → short-TTL signed URL via a download proxy.
Storage metered against `storage_bytes` at upload-intent. Reserved for future OCR: a
nullable `document_extraction` table; no OCR built now.

---

## 42 · 43. Payments, credit, refunds & Super-Admin-only secrets

**Financial correctness.** Money = `amount_minor BIGINT + currency_code +
currency_exponent` (2 for AED/SAR/QAR, 3 for KWD/BHD/OMR). All arithmetic in
`packages/money`. `NUMERIC` only in derived reporting columns. **No binary floating
point anywhere.** Methods: cash, card, payment providers, split, partial, customer
credit, credit limits, advance / wallet, refund, returns/exchange, failed/pending,
reconciliation. Payment state machine: `REQUIRES_ACTION → AUTHORIZED → CAPTURED →
PARTIALLY_REFUNDED → REFUNDED` · `FAILED · CANCELED · PENDING`, with an append-only
`payment_event` log. An order has many `payment_allocation`s across methods; the sum
reconciles to the order total; each has its own state. All financial operations are
transactional + audited; retryable operations and webhooks are idempotent.

**Payment provider adapter.** `PaymentProvider` port: `createIntent · authorize ·
capture · refund · getStatus · verifyWebhook`. Adapters (Stripe, Nomod, PayTabs,
Telr, mada-enabled…) are isolated and registered in a provider registry; no provider
is referenced by core business logic. Webhooks: per-provider endpoints, signature +
timestamp/replay verification, raw body stored, processed async via a queue,
idempotent on the provider event id. Refunds: recompute VAT on the refunded portion;
above-threshold refunds require `payments:refund:approve` + step-up. Reconciliation:
a daily job matches the provider settlement report to transactions and raises
exceptions.

**Super-Admin-only secrets (strict rule).** Only Platform Super Admin can create,
view, edit, rotate or revoke a raw external API credential — for payments, WhatsApp,
AI providers, SMS, or any integration. No Owner / Admin / Manager / POS / Staff user
can enter, reveal, edit, retrieve (even via a frontend API) or rotate a secret.
`provider_credential(id, tenant_id, company_id?, branch_id?, provider, mode
(TEST|LIVE), secret_blob_ref (KMS), non_secret_config, status, version, updated_by,
updated_at)` — a dedicated Super-Admin-only service with its own audit stream.
Branch-level credentials: Super Admin configures each (tenant, company, branch)
tuple; a bulk/templated screen keeps it manageable. Tenant users manage only
**non-secret operational settings** (which methods to display, min/max amount,
whether the AI may create orders, greeting text, business hours, handoff rules) —
separate columns/rows, never adjacent to a secret. KMS envelope encryption
(per-tenant DEK), decrypted server-side inside the owning module for one call,
masked in every UI (`••••4242`), never logged (redaction filter + tests), versioned,
revocable.

---

## F. Accounts, financial operations, cash register, shift & X/Z-Report

A production-grade financial foundation: one double-entry general ledger per
company, fed deterministically from the operational domains, plus POS-specific cash
registers, shifts and immutable Z-Reports.

### F.1 Financial source-of-truth & posting rules

- **The general ledger is a projection, not an input.** Each posting-worthy business
  event produces exactly one **balanced journal entry** (Σ debits = Σ credits) via a
  deterministic posting template.
- **Idempotency**: every `journal_entry` carries a unique `source_kind + source_id`
  (e.g. `ORDER_SETTLEMENT:{order_id}`, `PAYMENT:{payment_id}`,
  `CASH_MOVEMENT:{id}`). Re-posting the same source is a no-op.
- **Append-only**: journal entries and lines are immutable. A correction is a
  reversing entry plus a new entry, both audited — never an edit.
- **One GL per company** (each company is a legal entity with its own trade licence
  - VAT registration). Branch, POS terminal and shift are **dimensions** on every
    journal line. Tenant-level consolidation is a reporting rollup (ZF-3).
- **Posting is synchronous** and inside the operational transaction for core events;
  reporting rollups and period jobs are async via the outbox (ZF-2).

**Posting templates:**

| Business event                                             | Debit                               | Credit                                     | Prevents                                             |
| ---------------------------------------------------------- | ----------------------------------- | ------------------------------------------ | ---------------------------------------------------- |
| Cash sale (100 goods + 5 VAT)                              | Cash 105                            | Sales Revenue 100 · VAT Output 5           | counting the order _and_ the payment as revenue      |
| Card / provider sale                                       | Provider Clearing 105               | Sales Revenue 100 · VAT Output 5           | —                                                    |
| Provider settlement to bank                                | Bank · Provider Fees                | Provider Clearing                          | double-booking fees as expense and revenue reduction |
| Credit sale (unpaid)                                       | Accounts Receivable 105             | Sales Revenue 100 · VAT Output 5           | treating customer credit as cash received            |
| Customer pays down credit (cash)                           | Cash                                | Accounts Receivable                        | booking the repayment as new revenue                 |
| Customer advance received (cash)                           | Cash                                | Customer Advances (liability)              | treating an advance as ordinary sales revenue        |
| Advance applied to an order                                | Customer Advances 105               | Sales Revenue 100 · VAT Output 5           | double-counting the advance and the later sale       |
| Discount at point of sale                                  | Discounts (contra-revenue)          | —                                          | hiding gross vs net (ZF-7)                           |
| Delivery fee charged                                       | (part of Cash / AR)                 | Delivery Income                            | mixing delivery income into product revenue          |
| Refund (cash)                                              | Sales Returns (contra) · VAT Output | Cash                                       | leaving revenue & VAT overstated                     |
| Purchase — goods received (not yet billed)                 | Inventory (asset)                   | GRNI                                       | recording a purchase as an expense on receipt        |
| Supplier bill posted                                       | GRNI · VAT Input                    | Accounts Payable                           | double-counting purchase + bill                      |
| Supplier payment                                           | Accounts Payable                    | Cash / Bank                                | double-counting purchase + payment                   |
| COGS on sale / production (perpetual, weighted-avg — ZF-8) | COGS                                | Inventory                                  | —                                                    |
| Wastage / spoilage                                         | Wastage Expense                     | Inventory                                  | losing the financial impact of dead stock            |
| Cash expense (rent, fuel…)                                 | Expense account (by category)       | Cash / Petty Cash                          | —                                                    |
| Expense on credit                                          | Expense account                     | Accounts Payable / Accrued Expenses        | —                                                    |
| Other / manual income (cash)                               | Cash                                | Other Income account                       | mixing non-trading income into sales                 |
| Cash over / short at close                                 | Cash Over/Short (expense) _or_ Cash | Cash _or_ Cash Over/Short (income)         | silently absorbing a drawer difference               |
| Opening float / float return                               | Register Cash                       | Branch Cash / Safe (transfer, not revenue) | counting the float as a sale                         |

VAT input on purchases: `Dr VAT Input` on the supplier bill. VAT return = VAT Output
− VAT Input for the period, from the GL. Multi-currency: GL in the company's base
currency; foreign transactions store txn currency + rate; an FX Gain/Loss account
absorbs differences.

### F.2 Chart of Accounts (extensible)

`account(id, tenant_id, company_id, code, name_en, name_ar, type (ASSET | LIABILITY
| EQUITY | REVENUE | CONTRA_REVENUE | COGS | EXPENSE | OTHER_INCOME), parent_id,
is_postable, is_system, is_active)`. A localized default CoA is seeded per company at
provisioning; tenants extend it (`accounts:manage`). Sub-accounts allowed. The
posting engine never hard-codes an account id — it resolves stable **account keys**
(`CASH`, `PROVIDER_CLEARING`, `AR`, `AP`, `GRNI`, `VAT_OUTPUT`, `VAT_INPUT`,
`SALES_REVENUE`, `DELIVERY_INCOME`, `DISCOUNTS`, `SALES_RETURNS`, `COGS`,
`INVENTORY`, `WASTAGE_EXPENSE`, `CASH_OVER_SHORT`, `CUSTOMER_ADVANCES`, `PETTY_CASH`,
`FX_GAIN_LOSS`, …) to the company's mapped account. `accounting_period(company_id,
period, status (OPEN | SOFT_CLOSED | LOCKED))`. Posting into a non-open period needs
`accounts:manage` and lands as an adjustment in the current open period or a
deliberately reopened one — audited (ZF-6).

### F.3 Expenses

`expense_category(id, tenant_id, name_en/ar, account_id, requires_approval, active)`
— fully configurable. `expense(id, tenant_id, company_id, branch_id,
pos_terminal_id?, register_session_id?, category_id, amount_minor, currency,
tax_amount_minor?, tax_code?, payment_method (CASH | CARD | BANK | PETTY_CASH |
PAYABLE), payee_kind (SUPPLIER | STAFF | OTHER), payee_id?, expense_date,
description, reference, status (DRAFT | SUBMITTED | APPROVED | REJECTED | PAID),
created_by_user_id, approved_by_user_id?, decided_at)`. Permissions: `expense:create
/ edit / approve / pay`; approval required per category or above a threshold;
branch/tenant scoped. Receipts attach via `documents` (`owner_type = EXPENSE`). On
APPROVED + payment: posts `Dr Expense account / Cr Cash|Bank|Petty Cash|AP`. A
**cash** expense tied to an open register also writes a `CASH_OUT`-class `EXPENSE`
cash movement so the drawer and the Z-Report reflect it.

### F.4 Other / manual income

`other_income(id, tenant_id, company_id, branch_id, account_id, amount_minor,
currency, tax_amount_minor?, payment_method, source_reference, income_date,
description, document_id?, created_by_user_id, status)`. Posts `Dr Cash/Bank / Cr
Other Income`. System-generated **sales** revenue is never entered here — it always
stays linked to its order + payment source. Manual income is only for genuine
non-order receipts (scrap sale, rebate, insurance). Permissions `income:create /
edit / approve`.

### F.5 POS cash register & drawer (isolation rule)

Branch _operational_ sales/order data is shared across same-branch POS terminals
(§13). Physical _cash_ is not. `cash_register` and every `cash_movement` /
`register_session` are scoped to a single POS terminal. POS-01's drawer is never
mixed with POS-02's. `cash_register(id, tenant_id, company_id, branch_id,
pos_terminal_id, name, active)` — typically one per terminal. **Expected cash** is
computed by the backend: `opening_float + Σ signed cash movements (excluding
CLOSING)`. The cashier enters **counted cash**. `over_short = counted − expected`. A
difference is **never silently absorbed** — recorded, requires a reason, requires
`cash_register:override` / manager approval per policy, then posts to `Cash
Over/Short`.

### F.6 Register session / POS shift

`register_session(id, tenant_id, company_id, branch_id, pos_terminal_id,
cash_register_id, cashier_user_id, cashier_staff_id?, opened_at, closed_at?,
opening_float_minor, expected_cash_minor, counted_cash_minor?, over_short_minor?,
status (OPEN | COUNTING | CLOSED), payment_totals_json, refund_total_minor,
expense_total_minor, cash_movement_summary_json, opened_by_user_id,
closed_by_user_id?, approver_user_id?)`. Flow: Open (opening float) → POS operations
→ payments / refunds / expenses / cash movements → interim summary (X-Report) →
physical count → close → Z-Report. **Overlap policy**: a register has at most one
`OPEN` session; tenant policy governs concurrent open sessions on different
terminals and mid-day handover; enforced server-side. A sale on a terminal with no
open session is blocked or auto-opens per policy.

### F.7 Cash movement ledger

`cash_movement(id, tenant_id, company_id, branch_id, pos_terminal_id,
register_session_id, type, amount_minor (signed), currency, source_kind, source_id,
reason?, acting_user_id, staff_id?, occurred_at)` — append-only. Types:
`OPENING_FLOAT · CASH_SALE · CUSTOMER_PAYMENT · CASH_REFUND · CASH_IN · CASH_OUT ·
EXPENSE · SAFE_DROP · REGISTER_TRANSFER · ADJUSTMENT · CLOSING`. Every movement
carries a source reference + full audit context. **The calculated register balance
is never edited directly** — an `ADJUSTMENT` movement with a reason + approval is the
only way. Cash movements post to the GL where they represent a real financial event.

### F.8 X-Report — interim, does not close

A read-only computed snapshot of the _current open_ `register_session`. Can be run
any number of times. **Generating it never closes the register.** Optionally logged
(`x_report_log`: who, when). Contents: identity + opening float + gross sales +
discounts + net sales + VAT + delivery income + order count + cash + card + provider

- split + partial + credit + advances + refunds + returns + voids/cancels + expenses
  & cash-outs + cash-ins + **expected cash**. Permissions: `x_report:view`,
  `x_report:print`.

### F.9 Z-Report & immutability

Two levels: **(A) Register/Shift Z-Report** — the finalized closing snapshot of one
`register_session`; **(B) Branch Business-Day Close** — an optional per-tenant
aggregate of all sessions + non-cash / online activity for a business day, with its
own number (ZF-5). `z_report(id, tenant_id, company_id, branch_id, pos_terminal_id,
register_session_id, z_number, opened_at, closed_at, generated_by_user_id,
snapshot_json, integrity_hash, prev_hash, source_refs_json)` + `z_report_line`.
`z_number` is gapless per register (ZF-4). The snapshot is **frozen at close** and
hash-chained into the tenant audit chain. It is **never recomputed** from mutable
order data. Contents (formulas defined centrally, unit-tested): identity, sales
(gross / discounts / net / VAT / delivery income / order count), payments (cash,
card, provider, bank/other, split, partial, customer credit, customer advance
received/used), adjustments (refunds, returns, voids/cancellations, manager
overrides), cash (opening float, cash sales, cash customer receipts, cash refunds,
cash expenses, cash in, cash out, safe drops, expected cash, counted cash,
over/short), integrity metadata. **Corrections after close**: a reversing/correction
journal entry and (if needed) a `post_close_adjustment` note linked to the
Z-Report; the original row is immutable. **Closing sequence (one transaction):**
validate count entered → compute over/short → freeze the snapshot + hash → post
residual journal entries (over/short, float return, safe drop) → set session
`CLOSED` → emit `shift.closed` / `z_report.created`. Permissions: `z_report:view`,
`z_report:close`, `z_report:print`.

### F.10 Accounting ↔ inventory integration

Stock movements and financial postings are **not separate systems**. The operational
transaction that writes an `inventory_movement` also writes the matching
`journal_entry` in the same DB transaction: purchase receipt → `Dr Inventory / Cr
GRNI`; supplier bill → `Dr GRNI + Dr VAT Input / Cr AP`; material consumption /
production → `Dr COGS / Cr Inventory` at weighted-average cost (perpetual, ZF-8);
wastage / spoilage → `Dr Wastage Expense / Cr Inventory` at cost; sale → revenue +
VAT + cash/AR _and_ the COGS posting (once inventory cost exists — Phase 5); refund →
reverses revenue, VAT, and (for returned goods) COGS + inventory. The
transaction/outbox boundary: atomic cross-domain effects (stock + GL + cash movement

- order state) commit together in one transaction with one outbox event; downstream
  consumers are async. A nightly job reconciles the Inventory control account against
  the sum of `branch_inventory_balance` valuations.

### F.11 Owner financial management

Owner Web gains a Finance area with drill-down **tenant → company → branch →
POS/register → shift → transaction**, all scope-checked. Surfaces: sales, other
income, expenses, purchases, supplier payable, customer receivable, credit,
advances, refunds, cash position, payment-method totals, VAT, inventory valuation,
wastage cost, register over/short, branch comparison, POS comparison, daily /
monthly / yearly. Subledgers (`ar_transaction`, `advance_transaction`, supplier
balances) always reconcile to their GL control accounts. **"Profit" discipline**: a
figure is labelled profit only when the formula supports it.

### F.12 Reports added

Daily Sales · Sales by Branch / POS / Staff / Channel · Payment Method Summary ·
Income Report · Expense Report · Expense by Category · Cash Register Report · Shift
Report · X-Report · Z-Report · Cash Over/Short · Refund Report · Discount Report ·
Customer Credit / Receivable · Customer Advances · Supplier Payables · Purchase
Report · VAT / Tax Report · Inventory Valuation · Wastage Cost · Trial Balance ·
P&L by company / branch (management) — profitability only when COGS + expense
capture are complete. All fed from GL + summary tables, never ad-hoc OLTP scans.

---

## 44. Delivery

`delivery_zone` (per branch, polygon or area list), `delivery_charge_rule` (by zone
/ order value / distance), `time_slot` + `slot_capacity` (per branch per day —
peak-day aware), pickup option. `delivery(order_id, type (PICKUP | DELIVERY),
address_id?, recipient_id?, slot, scheduled_at, status, assigned_staff_id?,
dispatcher_user_id?)`; a **dispatch board** in POS _Manage_. Statuses: pending →
assigned → out for delivery → delivered / failed → rescheduled. `proof_of_delivery`
(photo + signature/OTP) via `documents`. Failed delivery + reschedule flows;
`delivery.updated` to the branch in real time; route optimization is a future
adapter port.

---

## 45. GCC localization & tax

- **Locales**: en + ar, full RTL (CSS logical properties + `dir`); every user-facing
  content field has a `translation` row.
- **Currencies**: AED, SAR, QAR, KWD, BHD, OMR with correct exponents; per-country
  default; multi-currency display for tourist cash where enabled; reporting-currency
  snapshots for consolidation.
- **Tax**: a config-driven engine — `country_tax_config` + `tax_category` +
  `tax_rate` with effective dates. Standard rates: UAE 5%, KSA 15%, Bahrain 10%,
  Oman 5%; Qatar & Kuwait have no VAT — modelled as "no tax," not 0%. Zero-rated /
  exempt categories supported. No country's rules are hardcoded in core order logic.
- **Legal invoice details** per company: legal name (en/ar), trade license + expiry,
  CR number, TRN / VAT number, registered address; gapless sequential numbering per
  company + document series; simplified vs full tax-invoice thresholds.
- **Phone**: E.164 with GCC country codes (+971/+966/+974/+973/+965/+968).
- **Timezones**: per branch; scheduled orders and attendance stamp local + UTC.
- **Calendars**: Hijri display, public holidays, Ramadan hours, weekend model per
  country — consumed by scheduling + delivery slots.
- **e-invoicing / fiscal**: an adapter port now (`EInvoicingProvider`); KSA ZATCA
  (Fatoora) and UAE e-invoicing implementations are a later phase (Z-8).

---

## 46. Audit & security model

See [`SECURITY.md`](SECURITY.md) for the full treatment. Summary:

**Request pipeline:** Authentication → Tenant (from session claim only) → Account /
session / device status → Registered device where required → Entitlement → Role →
Permission → Company scope → Branch scope → POS scope (only where the feature needs
it) → Resource access → Business rules → DB transaction (`SET LOCAL app.tenant_id`)
→ Audit (via outbox). Steps fail closed; list endpoints inject a scope filter
instead of rejecting.

**Isolation layers:** Application (scope only from the session into an immutable
`RequestContext`; reading it from body/param/header/subscription string is
banned — lint + test) · Query (`ScopedRepository` injects tenant + branch filters;
raw model access ESLint-forbidden in scoped modules) · Database (RLS on every tenant
table; a non-superuser role that cannot bypass it; platform operations use a
separate audited path) · Realtime (topic membership re-checks tenant + branch scope
on every subscribe and token refresh; revocation drops sockets) · Probe suite (CI:
for every endpoint, act as tenant B / branch Y and try to read tenant A / branch X
by id, param, URL, document id → expect 403/404; build fails on any leak).

**Audit:** append-only `audit_log`, per-tenant hash chain. Especially audited:
refunds, voids, discounts, credit, advances, payments, stock changes, reservations,
material consumption, wastage/spoilage, purchase changes, staff attribution changes,
attendance corrections, leave decisions, role/permission changes, integration
config, device activation, tenant/plan changes. `security_event` stream: failed
logins, new device, scope changes, secret access, impersonation, mass export.

**Other controls:** Argon2id; short-lived access token + server-side session
(revocation in seconds) + rotating refresh with reuse detection; step-up MFA; strict
CSP + secure headers; DTO input validation + output allowlist serialization;
per-tenant + per-IP rate limiting; brute-force lockout; webhook signature
verification; KMS-backed secret management with log redaction; PITR backups.

---

## 47. Reporting

Analytics never runs on the OLTP hot path. Owner gets tenant-wide reporting; normal
users stay branch- and permission-scoped.

1. **Operational reads** — bounded, indexed, scope-filtered, short-window; heavier
   ones hit the read replica.
2. **Summary / rollup tables** (`reporting` module) fed by outbox events + scheduled
   jobs: `rpt_sales_daily`, `rpt_channel_daily`, `rpt_payment_daily`,
   `rpt_material_consumption_daily`, `rpt_stock_valuation_snapshot`,
   `rpt_reservation_snapshot`, `rpt_wastage_daily`, `rpt_purchase_daily`,
   `rpt_supplier_balance`, `rpt_staff_sales_daily`, `rpt_florist_output_daily`,
   `rpt_attendance_daily`, `rpt_ar_aging`, `rpt_delivery_daily`, `rpt_tax_period`,
   `rpt_expense_daily`, `rpt_income_daily`, `rpt_cash_register_daily`,
   `rpt_over_short`, `rpt_gl_account_period` (trial-balance source),
   `rpt_pnl_period`. Dimensions: tenant, company, branch, POS, shift, channel, date,
   currency.
3. **Read replica + materialized views** for drill-down and ad-hoc.
4. **Analytics warehouse** (future) via outbox/CDC → columnar store when volume
   warrants; architecture-ready, not built now.

Drill-down (tenant → company → branch → POS/register → shift → transaction) is
scope-checked at every hop.

---

## 48. Feature entitlements & plan limits

Entitlement (does the plan include this?) is separate from RBAC permission (may this
user do it?). Super Admin owns plans, modules and limits.

**Limits (numeric, all distinct):** company · branch · POS terminal · registered POS
device · normal user/staff · owner-user · concurrent POS sessions · concurrent Owner
sessions · sessions per user · storage bytes. `Plan → limit defaults`, versioned;
per-tenant override with reason + audit; enforced by `LimitService` on create /
activate / login.

**Feature modules (on/off + config):** Customer Web · AI WhatsApp · Customer Web AI ·
Advanced Inventory · Production / BOM · Biometric Attendance (+ Face · Fingerprint ·
RFID sub-features) · Advanced Reporting · Delivery. A permission whose module is not
entitled is inert.

---

## 49. Background jobs & events

- **Transactional outbox** — a domain write and its `outbox` row commit together; a
  `SKIP LOCKED` dispatcher publishes to the in-process event bus, BullMQ, the Redis
  Stream (realtime) and reporting.
- **BullMQ queues** (separate, per concern, own concurrency + retry/backoff + DLQ):
  notifications, documents (AV), payments-webhooks, reconciliation,
  reporting-rollups, ai, whatsapp, attendance-ingest, exports, reservation-expiry,
  subscription-generation, commission-calc, cache-invalidation, e-invoicing (future).
- **Scheduler**: nightly rollups, balance reconciliation, reservation +
  activation-code + session expiry, trade-license / plan-expiry reminders,
  aging-stock / spoilage suggestions, subscription instances, settlement
  reconciliation, backup-verification triggers.
- **Idempotency store**: `idempotency_key(key, scope, request_hash,
response_snapshot, expires_at)` for external-facing and retried operations.

---

## 50. Observability, backup & recovery

**Observability:** Structured JSON logs (pino) with correlation id + tenant id;
secrets/PII redacted. Metrics (Prometheus → Grafana): HTTP, queue depth/lag/failures,
outbox lag, realtime stream lag & socket counts, DB pool, cache hit, auth failures,
payment success, webhook lag, reservation-expiry backlog, balance-drift alerts.
Tracing: OpenTelemetry across api → worker → realtime → DB → external. Error
tracking: Sentry / GlitchTip with PII scrubbing. Health: `/healthz`, `/readyz` (DB,
Redis, storage, migrations); synthetic checks. Security dashboards: impersonation,
mass export, auth-failure spikes, secret access, RLS errors.

**Backup & DR:** PostgreSQL: daily base backup + continuous WAL archiving → PITR.
Target RPO ≤ 5 min, RTO ≤ 1–2 h. Scheduled restore drills into an isolated
environment, verified by row counts + an app smoke test, reported. Object storage:
versioning + lifecycle + cross-region replication for documents; immutable backup
for fiscal documents (GCC retention 5+ years). Redis: cache rebuildable; queues +
streams use AOF; small loss window accepted (handlers idempotent). Tenant-level
export (portability) and hard-delete (offboarding) with legal-hold override for
financial records. Terraform-defined infra; documented DR runbook; config-driven
secondary region (not built now). Migrations: reviewed, forward-only
(expand/contract), tested on prod-like volume, backup checkpoint before anything
destructive.

---

## 51. Temporary network-loss strategy

POS is online-first. On connection loss it degrades to read-mostly plus a small set
of provably-safe queued actions, with a loud banner and a visible queue. **No
full-offline claim.**

| Class                         | Operations                                                                                                                                                                                                                                                                                                                                                                                       | Mechanism                                                                                                                                                      |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A — safe offline**          | attendance punches; draft carts & hold/resume; quotation creation (no stock/payment effect); driver POD photo + status note; viewing cached catalog / prices / own schedule                                                                                                                                                                                                                      | ordered IndexedDB queue, replayed with an `Idempotency-Key`; server assigns authoritative numbers; clock-offset correction                                     |
| **B — conditionally safe**    | completing a _cash-only, no-credit, no-loyalty_ walk-in sale of **STOCKED** items against cached price/tax (never a BOM or custom bouquet)                                                                                                                                                                                                                                                       | only if the tenant enables `pos.offline_cash_sale`; provisional receipt number replaced on sync; any conflict → supervisor review queue, never auto-void (Z-6) |
| **C — online-only (blocked)** | any inventory or reservation write; BOM / custom-bouquet sales; card / wallet / provider payments; refunds; voids of synced sales; credit & advance; gift-card / loyalty; adjustments / transfers / counts; receiving; Z-report finalize; device activation; role / permission / user / secret changes; reading another branch's data; anything money-moving in the ledger; online-order actions | hard-blocked with "this needs a connection"                                                                                                                    |

On reconnect, the queue replays in order; the server is authoritative; conflicts
surface for a human, never silently dropped or forced.

---

## 52 · 53. High-level domain model & indexing / concurrency

See [`DOMAIN-MODEL.md`](DOMAIN-MODEL.md) for the full entity model and financial
concepts. Conventions: UUID v7; `tenant_id` on every tenant row; `company_id` /
`branch_id` on operational rows; `created_at/by`, `updated_at/by`; money as minor
units + currency + exponent; quantities `NUMERIC(18,4)` in base UOM; extensible
concepts as strings + reference tables, not PG enums.

**Indexing & concurrency strategy:**

- Composite indexes lead with `tenant_id`, then `branch_id`, then the query key.
  Partial indexes for queue-style reads (open reservations, pending online orders,
  unresolved exceptions).
- **Partitioning from migration #1** on high-volume tables: `order`, `order_line`,
  `payment_event`, `inventory_movement`, `stock_reservation`, `journal_entry`,
  `journal_line`, `cash_movement`, `attendance_event`, `audit_log`, `ai_message`,
  `notification_log`, `outbox`, `idempotency_key` — range on `created_at` (or hash
  on a tenant bucket for the largest).
- **Ledger invariants**: a DB constraint / trigger enforces Σ(debit) = Σ(credit) per
  `journal_entry`; `(source_kind, source_id)` is unique; posting into a `LOCKED`
  period is rejected at the service layer with an audited override path.
- **Locking**: row locks / advisory locks per `(branch_id, item_id)` for stock;
  optimistic `version` columns on aggregates (Order, BranchInventoryBalance);
  `FOR UPDATE SKIP LOCKED` for the outbox dispatcher and job pickup.
- **Idempotency** everywhere external or retryable; **gapless sequences** via a
  dedicated numbering service that allocates inside the business transaction.
- Read replica for reporting; `pg_trgm` indexes for product / customer search.

---

## 54. Testing strategy

See [`../conventions/TESTING-STRATEGY.md`](../conventions/TESTING-STRATEGY.md).
Suites: Unit (Vitest — policy truth tables, money & UOM math incl. 3-decimal /
fractional, recipe explosion, availability math, state machines) · Integration
(Testcontainers: Postgres + Redis + MinIO — repositories, RLS behaviour, outbox,
transactions) · API e2e (full request pipeline per endpoint) · **Tenant-isolation
suite** (build-blocking) · **Branch-isolation suite** · **Concurrency suite**
(parallel sales → no oversell; reservation + adjustment; atomic BOM; idempotent
replay of sale / receipt / webhook / attendance / journal posting) · **Financial
suite** (payment totals; split & partial; credit ≠ cash; advances; refunds reverse
revenue + VAT; expenses hit drawer + Z; cash math; X/Z formulas; Z immutability;
purchase ≠ payment; every posting balances; subledger-to-control reconciliation;
register isolation; inventory↔accounting atomicity) · Realtime suite · AI suite
(prompt-injection / tool-abuse, value caps, context-binding, confirmation-required)
· Web e2e (Playwright) · Load (k6). **No test is silently skipped**; DB / security /
isolation checks run locally before commit.

---

## 55. Deployment & migration strategy

- **Local dev**: `docker compose up` → Postgres, Redis, MinIO, ClamAV, Mailpit; one
  command, seeded fixtures.
- **Environments**: dev → staging (prod-like volume) → production. Terraform-defined;
  a single managed container platform (ECS / Fly / Hetzner+Nomad) — **no
  Kubernetes** until scale demands it.
- **Runtime roles** deployed as separate services from one image: `api`, `worker`,
  `scheduler` (singleton), `realtime`. Super Admin Web is a separate deployment.
- **Migrations**: Prisma Migrate, forward-only, **expand/contract** (add nullable →
  backfill job → enforce → drop) so deploys are zero-downtime; every migration
  reviewed, tested on staging volume, preceded by a backup checkpoint if
  destructive.
- **CI gates**: typecheck · lint (boundary + no-raw-model + route-permission) · unit
  · integration · API e2e · tenant + branch isolation suites · concurrency suite ·
  build · SBOM + dependency audit + Trivy + secret scan.
- **Release**: tagged, changelog, version + migration-status endpoint, staged
  rollout, fast rollback.
- **Post-approval sequence**: architecture + spec docs → `CLAUDE.md` → `git init` →
  monorepo init → local Docker infra → Phase 0, one task at a time, each tested +
  security-reviewed + isolation-reviewed before a stable commit.

---

## 56. Phased implementation roadmap

See [`ROADMAP.md`](ROADMAP.md) for the full 11-phase roadmap with per-phase exit
criteria. Classes: **A** foundation required now (Phases 0–4) · **B** core product
(3–9) · **C** required later, architecture-ready now (9–10) · **D** optional future.
No explicitly-required feature is classed D.
