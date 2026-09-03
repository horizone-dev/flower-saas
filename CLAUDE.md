# CLAUDE.md — Flower SaaS permanent project rules

> Loaded every session. These rules are **non-negotiable** and override any default
> behaviour. They derive from the approved architecture v0.4
> ([`docs/architecture/ARCHITECTURE.md`](docs/architecture/ARCHITECTURE.md)) and the
> decision log ([`docs/decisions/DECISION-LOG.md`](docs/decisions/DECISION-LOG.md),
> all 23 decisions APPROVED 2026-09-03). Where the V3 requirements revision and the
> original Master Prompt conflict, **V3 governs**.

Flower SaaS is a **multi-tenant florist commerce SaaS for the GCC** (UAE, KSA, Qatar,
Kuwait, Bahrain, Oman): a **modular monolith** — one TypeScript codebase with
`api` / `worker` / `scheduler` / `realtime` runtime roles, four user-facing web
apps, PostgreSQL + Redis + object storage.

---

## 1. Golden rules

1. **The backend is the only authoritative business-logic layer.** No pricing, tax,
   inventory, permission, credit, discount or financial rule lives in any frontend.
   Authoritative business logic lives **only in `apps/api`** and is imported (not
   duplicated) by `apps/worker` and `apps/scheduler`.
2. **Four apps only** — Super Admin Web, Owner Web, POS PWA, Customer Web. **No
   Staff App. No fifth/sixth app.** The full workforce module lives inside the POS
   PWA. `/v1/me/*` self-service exists but its only consumer is the POS PWA.
3. **No premature complexity** — no microservices, no Kubernetes, no speculative
   abstraction, no analytics warehouse, no multi-region until scale demands it.
4. **No product/domain features outside the current approved phase.** Phase 0 writes
   **no domain code** — repo scaffolding, infra, CI and the RLS spike only.

## 2. Tenant & branch isolation (see [`SECURITY.md`](docs/architecture/SECURITY.md))

5. `tenant_id` and `branch_id` come **only** from the authenticated session, into an
   immutable `RequestContext`. Reading a scope value from a request body, param,
   header, query string or realtime subscription string is a **banned pattern**
   (ESLint-enforced + tested).
6. Every scoped read/write goes through `ScopedRepository`, which injects the
   tenant + branch filter. **Raw Prisma/model access is ESLint-forbidden in scoped
   modules.**
7. **RLS on every tenant-owned table** (`tenant_id = current_setting('app.tenant_id')`).
   The app connects as a non-superuser role that cannot bypass RLS. Platform
   operations use a separate, audited path. `SET LOCAL app.tenant_id` is issued
   inside every request transaction. (RLS + pooling posture: ADR-0010.)
8. **Branch is THE operational data boundary.** A POS terminal id is
   identity / origin / cash-session / audit / reporting **only** — never an
   isolation boundary. Same-branch POS terminals and that branch's Customer Web
   slice share the same authoritative branch data.
9. Every controller route declares an explicit permission (`@RequirePermission(...)`)
   or `@Public()`. A route with neither **fails lint**.
10. A cross-tenant / cross-branch **probe suite** runs in CI and is build-blocking.
    Any leak fails the build.

## 3. Identity, users, staff, RBAC

11. **`user` ≠ `staff`.** A staff member can exist with no login (`staff.user_id` is
    nullable). Disabling a user ends sessions and touches nothing else. Terminating
    staff end-dates assignments and **deletes no history / attribution**.
12. **Authenticated user ≠ transaction staff attribution.** `acting_user_id` /
    `created_by_user_id` record who was authenticated and are **never overwritten**.
    Staff attribution (`SALESPERSON`, `FLORIST`, `CASHIER`, `APPROVER`, `DRIVER`) is
    separate, many-per-order, and audited on change.
13. **Role ≠ permission ≠ data scope ≠ entitlement** — four independent axes checked
    every request. A job title is never any of them. **Deny wins.** Step-up MFA
    gates money, permission, secret and attribution-change actions.
14. A permission whose feature module is not entitled is **inert** — UI hides it, API
    rejects it.

## 4. Money & financial truth (see [`ARCHITECTURE.md` §F](docs/architecture/ARCHITECTURE.md))

15. **Money = integer minor units + currency code + currency exponent.** KWD, BHD,
    OMR are **3-decimal**. All arithmetic goes through `packages/money`. **No binary
    floating point anywhere.** `NUMERIC` only in derived reporting columns.
16. **The general ledger is an append-only projection, not an input.** Each
    posting-worthy business event produces exactly **one balanced journal entry**
    (Σ debits = Σ credits), keyed by a unique `source_kind + source_id` →
    re-posting the same source is a no-op. Order + payment = **one** entry, not
    three revenues. Credit ≠ cash. Advance ≠ revenue. Purchase (asset + payable) ≠
    supplier payment.
17. **One GL per company** (legal entity / VAT registration). Branch, POS terminal
    and shift are **journal-line dimensions**, not separate ledgers. Tenant
    consolidation is a reporting rollup.
18. **GL posting is synchronous, inside the operational transaction** for core
    events (sale, refund, payment, cash movement, expense, purchase receipt,
    consumption, wastage). Rollups and period jobs are async via the outbox.
19. **Z-Reports are immutable** — frozen at close, hash-chained, gapless `z_number`
    per register. Never recomputed from mutable order data. Post-close corrections
    are **reversing entries + an adjustment note**; the original Z is untouched.
20. Discounts and returns are booked as **contra-revenue** (gross / discount / net
    all visible). COGS uses **perpetual weighted-average**. A drawer difference is
    never silently absorbed — recorded, reasoned, approved, posted to Cash Over/Short.
21. A figure is labelled "profit" **only** when the formula supports it (Gross Profit
    = Net Revenue − COGS, real from Phase 5; Net Profit for a closed period).
    Before that: "contribution" / partial margin.

## 5. Inventory

22. **Append-only movement ledger.** Never overwrite a quantity. Balances
    (`branch_inventory_balance`) are a derived projection, reconciled nightly against
    the ledger.
23. Every stock-affecting operation runs in one transaction that **locks the
    `(branch_id, item_id)` balance row** (or an advisory lock keyed by
    `hash(branch_id, item_id)` for multi-item BOM writes), re-checks availability
    **inside the lock**, and requires an **`Idempotency-Key`**.
24. **Adding to a cart never consumes or hard-reserves stock.** Lifecycle: cart
    (availability check + optional soft hold) → reservation on order confirm →
    consumption on production/hand-off. One `AvailabilityService` for all channels.
25. Inventory ↔ GL postings are **atomic** — the transaction that writes an
    `inventory_movement` writes the matching `journal_entry` (receipt
    `Dr Inventory / Cr GRNI`; consumption `Dr COGS / Cr Inventory`; wastage
    `Dr Wastage / Cr Inventory`).

## 6. Secrets

26. **All raw external credentials** (payments, WhatsApp BSP, AI providers, SMS, any
    integration) are **Platform Super Admin only**. No Owner / Admin / Manager /
    POS / Staff user may create, view, edit, rotate or retrieve a secret — not even
    via a frontend API. The capability does not exist in the tenant realm.
27. Secrets: KMS envelope encryption (per-tenant DEK), decrypted server-side inside
    the owning module for one call, masked in every UI (`••••4242`), **never logged**
    (redaction filter + tests), versioned, revocable. Tenant users manage only
    **non-secret operational settings**, stored in separate columns/rows.

## 7. Transactions, events & realtime

28. **Transactional outbox is the backbone.** A domain write and its `outbox` row
    commit together. A `SKIP LOCKED` dispatcher fans out to the in-process bus,
    BullMQ, Redis Streams (realtime) and reporting. Nothing lost for money / stock /
    audit / integrations.
29. Atomic cross-domain effects (stock + GL + cash movement + order state) commit
    together in **one transaction with one outbox event**. Downstream consumers
    (reporting rollups, realtime, notifications) are **async and idempotent**.
30. Realtime is an **accelerator, never the source of truth** — every screen is
    buildable from REST; a confirm action always re-validates server-side. Realtime
    topics are **server-derived from the session**; a client cannot request an
    arbitrary topic string. Subscription re-runs the guard pipeline on every
    subscribe and on token refresh; session revocation drops sockets.

## 8. Offline

31. **Financial and inventory-changing sales are ONLINE-ONLY for v1** (Z-6). The PWA
    may cache UI / read-only / low-risk reference data for temporary network loss.
    Class C operations (any inventory/reservation write, BOM/custom sales, provider
    payments, refunds, credit, adjustments, receiving, Z finalize, role/secret
    changes, cross-branch reads, online-order actions) are **hard-blocked offline**.
    Controlled offline cash-sale (Class B) stays architecture-ready behind a tenant
    flag, implemented only after a separately approved conflict / numbering /
    reservation / idempotency / reconciliation model.

## 9. Regions & fiscal

32. **UAE-region primary**, region-portable, **KSA-data-residency-ready** — never
    hardcode to one region (`tenant.region`). Verify KSA compliance + support a KSA
    data boundary **before** KSA production onboarding (Z-3).
33. Fiscal / e-invoicing sits behind **country-specific adapter ports**
    (`EInvoicingProvider`). **KSA onboarding is GATED** until ZATCA (Fatoora)
    integration/compliance for the target operating model is implemented and
    verified — not deferred to a generic hardening phase if KSA is being onboarded.
    Other GCC fiscal rules stay country-configurable, never hardcoded (Z-8).

## 10. Providers

34. Provider/adapter **ports** for payment, AI/LLM, WhatsApp BSP and SMS are
    approved now; the core never depends on one vendor. Actual vendor selection is
    deferred to the relevant implementation phase (Z-4). Payment config is
    tenant / company / branch-scoped without leaking secrets to Owner/POS.

## 11. Process & Git (see [`GIT-WORKFLOW.md`](docs/conventions/GIT-WORKFLOW.md))

35. **One task at a time.** Run tests + local verification after **every** task.
    Review tenant/branch isolation, auth/security and DB correctness continuously.
    **No silently skipped tests.** Do not weaken RLS, security, isolation, lint or
    test requirements to make a check pass.
36. **Commit only green states to `main`.** Conventional Commits, enforced by
    commitlint. One verified commit per completed task. Trunk-based; short-lived
    `phase-<n>/<task>-<slug>` branches; self-review PR runs the CI gate.
37. **No history rewrite. No force-push.** Recovery is revert-forward. `main` is
    always buildable. Annotated checkpoint tags after verified milestones
    (`spec-frozen-v0.4`, `phase-0-infra`, `phase-0-ci`, `phase-0-complete`,
    `phase-<n>-complete`).
38. Never commit: secrets, `.env`, `node_modules`, build output, coverage.
39. Commit trailer on every commit:
    ```
    Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
    Claude-Session: <session url>
    ```
    PR description footer: `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
40. **STOP at each `phase-<n>-complete` tag** and wait for explicit owner approval
    before starting the next phase.

## 12. Project isolation

41. This machine also holds a separate **Salon SaaS** project. **Never** modify,
    initialize, clean, reset, delete, migrate or inspect the Salon SaaS repo or its
    data. Flower SaaS has its own git repo, Docker Compose project, databases,
    volumes, networks and config. Namespace all Docker resources `flower` /
    `flower-saas`. Never use broad destructive Docker cleanup commands.
42. Flower SaaS repo root is **`C:\Users\EXPERT\Desktop\Flower SaaS`**.
    Origin: `https://github.com/horizone-dev/flower-saas.git`.

## 13. Toolchain (see [ADR-0013](docs/decisions/ADR-0013.md))

43. Node 24 (`.nvmrc`), **pnpm pinned** via `packageManager` + sha512 +
    `.npmrc` strict mode. TypeScript strict everywhere. Deliberate version
    deviations from the frozen plan are recorded in an ADR, never silent.
