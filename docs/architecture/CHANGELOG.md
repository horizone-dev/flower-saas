# Flower SaaS — Specification changelog

Version history of the architecture / specification of record. Append-only.

## v0.4 — 2026-09-03 — APPROVED + Phase 0 execution plan

- Architecture **APPROVED**. All 23 decisions resolved (Z-1…Z-14, ZF-1…ZF-9) —
  see [`../decisions/DECISION-LOG.md`](../decisions/DECISION-LOG.md).
  - Z-3 (hosting): UAE-region primary; region-portable; KSA-data-residency-ready.
  - Z-4 (providers): adapter ports approved now; vendor selection deferred; all raw
    credentials Super-Admin-only.
  - Z-6 (offline): first release = financial + inventory-changing sales ONLINE-ONLY;
    Class B behind a future flag after separate approval.
  - Z-8 (KSA e-invoicing): country adapters; KSA onboarding GATED until ZATCA
    integration is implemented + verified.
- Added §P0 — the Phase 0 execution plan (docs to freeze, monorepo tree, tasks
  0.1–0.13, local services + ports, verification, Git checkpoints). Frozen here as
  [`../phase-0/PHASE-0-PLAN.md`](../phase-0/PHASE-0-PLAN.md).
- This document set (this repo's `docs/`) is the Markdown rendering of v0.4.

## v0.3 — 2026-09-03 — Production-grade financial / accounting foundation

- **New modules**: `accounting` (chart of accounts + double-entry journal + posting
  engine + accounting periods), `cash-register` (POS-terminal-scoped registers,
  register sessions/shifts, append-only cash-movement ledger, X-Report, immutable
  Z-Report), `expenses` (expenses + configurable categories + approval + other
  income). Former `ledger` module renamed `receivables`; it now **reconciles to** the
  GL rather than being the money truth.
- **Source-of-truth rule**: operational domains own operational truth; the GL is a
  deterministic append-only **projection** of their events. One balanced journal
  entry per business event, keyed by unique `source_kind + source_id` → no
  double-counting.
- **One GL per company**; branch / POS / shift are journal-line dimensions; tenant
  consolidation is a reporting rollup.
- GL posting synchronous inline for core events; async for rollups.
- Cash register / drawer is POS-terminal-specific (not branch-shared, unlike order
  data). Expected cash = float + Σ signed cash movements; over/short recorded +
  approved, never silently absorbed.
- X-Report = interim, repeatable, does not close. Z-Report = frozen immutable
  snapshot at close, hash-chained, gapless `z_number`.
- Perpetual weighted-average COGS; inventory↔GL postings atomic.
- Roadmap renumbered: new Phase 3 adds double-entry GL + receivables; new Phase 4 =
  cash register + shift + X/Z-Report + expenses + other income; old phases 4–9 →
  5–10.
- New permissions: `accounts:* · income:* · expense:* · cash_register:* ·
x_report:* · z_report:* · financial_reports:view`.
- 9 new decisions ZF-1…ZF-9.

## v0.2 — 2026-09-03 — V3 FINAL REQUIREMENTS REVISION incorporated

Where V3 conflicts with the original Master Prompt, **V3 wins**.

- **FOUR apps only** (Super Admin Web, Owner Web, POS PWA, Customer Web). No Staff
  App, no scaffold. Full workforce lives inside the POS PWA. `/v1/me/*` self-service
  API still built (POS-only consumer).
- **No Warehouse domain.** Inventory is branch-based; balances keyed by `branch_id`.
  Branch-to-branch transfers remain.
- **Owner Web = full tenant-wide business management** (not read-only dashboards).
- **Branch is THE operational data boundary.** POS terminal id = identity / origin /
  cash-session / audit / reporting only.
- **Realtime is a hard requirement**: Postgres → outbox → Redis Streams → WebSocket
  gateway → branch-authorized clients. Event list + reconnect/missed/dedup/
  out-of-order/restart semantics specified.
- **AI WhatsApp AND Customer Web AI chatbot are REQUIRED core modules** on a shared
  secure tool/orchestration layer (10 fixed tools). AI never has direct DB access;
  tenant/branch context bound server-side.
- **ALL external API secrets are Platform Super Admin ONLY.** No tenant-realm user
  can enter / view / edit / rotate secrets.
- **User ≠ Staff** is a hard rule.
- Raw-material inventory, UOM (fractional), movement ledger (append-only), stock
  reservation lifecycle, predefined BOM explosion, custom-bouquet builder with full
  component snapshot, production/work-orders, wastage/spoilage — all core early
  phases (3–6), not late polish.
- Money = integer minor units + currency + exponent (KWD/BHD/OMR are 3-decimal).

## v0.1 — 2026-09-03 — Initial architecture proposal

Modular monolith, TypeScript monorepo, NestJS + Next.js + Postgres + Prisma + Redis +
BullMQ + S3, one codebase with api/worker/scheduler/realtime entrypoints. Original
five-app assumption (incl. a Staff Mobile App) and a Warehouse domain — both
superseded by v0.2.
