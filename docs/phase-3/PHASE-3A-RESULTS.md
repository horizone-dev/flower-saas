# Phase 3a (catalog) — verification results

> Produced by **Task 3.11** (`phase-3/task-3.11-verification`). Records what
> Phase 3a (Tasks 3.1 → 3.10) delivered, the evidence for every hard gate, the
> dual-tenant Business-Type-neutrality proof, and the explicit boundary of what
> was **not** built.
>
> Governing plan: [`PHASE-3-PLAN.md`](PHASE-3-PLAN.md) — task table entry:
> _"3.11 | Phase 3a verification pass + `PHASE-3A-RESULTS.md` + `phase-3a-catalog-complete` tag | — | no [migration] | depends on 3.1–3.10"_.
>
> **This is Phase 3a (catalog) completion only — not full Phase 3.** Phase 3b
> remains. A `phase-3-complete` tag may only be created after the full Phase 3
> roadmap exit criteria, including all of Phase 3b, are satisfied (D2-1).

---

## 1. Baseline and integrated commits

| Task                                           | Commit(s)                                                         | Landed on `main` |
| ---------------------------------------------- | ----------------------------------------------------------------- | ---------------- |
| 3.1 — capability foundation                    | `17b8623`… (squashed into Phase 3a history)                       | yes              |
| 3.2 — Category/Product Type/Product core       | —                                                                 | yes              |
| 3.3 — typed attributes                         | —                                                                 | yes              |
| 3.4 — variants/option groups                   | —                                                                 | yes              |
| 3.5 — identifier registry                      | —                                                                 | yes              |
| 3.6 — UOM/pack conversions                     | —                                                                 | yes              |
| 3.7 — company pricing                          | `17b8623`, `b65d90e` (fix)                                        | yes              |
| 3.8 — branch pricing                           | `e333f9d`, `bd3dc68`, `e11a04d` (fixes)                           | yes              |
| 3.9 — tax category                             | `4a8cce7`, `cd4444a`, `80942de` (fixes)                           | yes              |
| 3.10 — template re-apply + outbox + realtime   | `8995cf8`, `c1775ec` (CHECK 1/2), `83d2255` (strict-review fixes) | yes              |
| Infra — MinIO CI fix (unrelated, merged first) | `5d03f3a`                                                         | yes              |
| **3.11 — Phase 3a verification (this doc)**    | _this branch_                                                     | pending PR merge |

**Baseline at Task 3.11 start:** `main` @ `83d225588166d33de1e366ec73be77cbf1cffe38`
(local == origin, working tree clean, both `20260913120000_catalog_tax_category`
and `20260914120000_catalog_realtime_company_scope` present exactly once,
historical tags unchanged, MinIO = `quay.io/minio/minio:RELEASE.2025-04-08T15-41-24Z`).

**Final integrated `main` commit + `phase-3a-catalog-complete` tag:** to be
stamped after owner-approved merge and push-to-main CI green on all four jobs.

### Full verification matrix (Task 3.11 branch HEAD)

| Check                                                                                  | Result                  |
| -------------------------------------------------------------------------------------- | ----------------------- |
| `pnpm -w typecheck`                                                                    | 34/34 ✅                |
| `pnpm -w lint` (boundaries + no-raw-prisma + route-permission + no-scope-from-request) | 35/35 ✅                |
| `pnpm -w build`                                                                        | 21/21 ✅                |
| `pnpm format:check` (prettier)                                                         | ✅                      |
| `pnpm -w test` (whole workspace, Testcontainers)                                       | **34/34 tasks, exit 0** |
| — `@flower/api`                                                                        | 537 passed (40 files)   |
| — `@flower/db` (migration + gcc-reference-data + catalog-capabilities)                 | 148 passed              |
| — `@flower/worker` (outbox/dispatcher, realtime-relay, stream-retention)               | 89 passed               |
| — `@flower/realtime` (gateway, auth/topics, resume/replay)                             | 53 passed (8 files)     |
| — `@flower/backend`                                                                    | 17 passed               |
| — `@flower/scheduler`                                                                  | 12 passed               |
| — `@flower/testing` (harness incl. **real MinIO container**, probes, boundary)         | 16 passed               |
| — `@flower/money`                                                                      | 49 passed               |
| — `@flower/uom`                                                                        | 67 passed               |
| — `@flower/permissions`                                                                | 24 passed               |
| — `@flower/shared-types`                                                               | 38 passed               |
| — `@flower/api-client`                                                                 | 18 passed               |
| — `spike-rls` (RLS + PgBouncer)                                                        | 21 passed               |
| — `@flower/i18n` / `@flower/ui`                                                        | 4 / 3 passed            |
| `@flower/config test:negative` (boundary + scope violation must fail lint)             | ✅                      |

---

## 2. Tasks 3.1–3.10 completion matrix

| Task                                           | Implementation                                                                                                                                        | Migration                        | Permissions                                                                             | Capabilities gated                                 | Key audit actions                                                                                              | Tests                                              |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| **3.1** Capability foundation                  | `platform/catalog-capability.{controller,service,repository}.ts`, `packages/db/prisma/catalog-capabilities.ts`                                        | `catalog_capability_foundation`  | `platform:catalog_capability:manage` (+step-up on PATCH), `platform:tenants:view`       | _is_ the 16-key registry — gates nothing on itself | `tenant.catalog_capability_changed`, `catalog.template_applied`                                                | 17                                                 |
| **3.2** Category/Product Type/Product          | `category.*`, `product-type.*`, `product.{controller,service,repository}.ts`                                                                          | `catalog_core`                   | `catalog:view` / `catalog:manage`                                                       | `strategy.stocked`/`.bom`/`.custom`                | `catalog.category_*`, `catalog.product_type_*`, `catalog.product_*`                                            | 27                                                 |
| **3.3** Typed attributes                       | `attribute-definition.*`, `attribute.helpers.ts`, `product-attribute.*`                                                                               | `catalog_attributes`             | `catalog:view` / `catalog:manage`                                                       | none                                               | `catalog.attribute_definition_*`, `catalog.attribute_option_set_changed`, `catalog.product_attributes_changed` | 23                                                 |
| **3.4** Variants/option groups                 | `variant.{controller,service,repository,helpers}.ts`, `option-group.*`                                                                                | `catalog_variants`               | `catalog:view` / `variants:manage`                                                      | `variants`                                         | `catalog.variant_*`, `catalog.option_group_*`, `catalog.option_value_set_changed`                              | 23                                                 |
| **3.5** Identifier registry                    | `identifier.{controller,service,repository,helpers}.ts`                                                                                               | `catalog_identifiers`            | `catalog:view` / `identifiers:manage`                                                   | `multi_uom` (pack units), `identifiers.barcode_qr` | `catalog.identifier_created/deleted/deactivated/reactivated`                                                   | 30                                                 |
| **3.6** UOM/pack conversions                   | `uom.{controller,service,repository,helpers}.ts`, `uom-conversion.repository.ts`, `packages/uom`                                                      | `catalog_uom`                    | `catalog:view` / `catalog:manage` / `variants:manage`                                   | `multi_uom` (built-ins exempt)                     | `catalog.uom_*`, `catalog.variant_conversions_changed`, `catalog.product_conversions_changed`                  | 25 (+ 67 package-level exactness)                  |
| **3.7** Company pricing                        | `company-pricing.{controller,repository,helpers}.ts`                                                                                                  | `catalog_company_pricing`        | `catalog:view` / `pricing:manage`                                                       | none (pure PUT)                                    | `catalog.company_price_changed`                                                                                | 33                                                 |
| **3.8** Branch pricing                         | `branch-pricing.{controller,service,repository,helpers}.ts`, `branch-price-integrity.repo.ts`                                                         | `catalog_branch_pricing`         | `catalog:view` / `branch_price:manage`                                                  | `branch_pricing` (prices AND availability)         | `catalog.branch_price_changed`, `catalog.branch_availability_changed`                                          | 36 (+ static + probe suites)                       |
| **3.9** Tax category                           | `tax-category.{controller,repository}.ts`                                                                                                             | `catalog_tax_category`           | `catalog:manage` (product) / `variants:manage` (variant, O1) / `catalog:view` (resolve) | none                                               | `catalog.product_tax_category_changed`, `catalog.variant_tax_category_changed`                                 | 35                                                 |
| **3.10** Template re-apply + outbox + realtime | `catalog-capability.*` (`reapply`), `catalog-events.ts`, `outbox.writer.ts`, product/variant/company/branch repos, `apps/realtime/src/auth/topics.ts` | `catalog_realtime_company_scope` | `platform:catalog_capability:manage` +step-up                                           | none new                                           | `catalog.template_applied` (re-apply shape)                                                                    | 32 (capability) + resume/gateway/dispatcher suites |

All of 3.1–3.6 confirmed tenant-isolated via `ScopedRepository` (no raw Prisma access).

---

## 3. Phase 3 migrations (10, chronological)

`catalog_capability_foundation` → `catalog_core` → `catalog_attributes` →
`catalog_variants` → `catalog_identifiers` → `catalog_uom` →
`catalog_company_pricing` → `catalog_branch_pricing` → `catalog_tax_category` →
`catalog_realtime_company_scope`.

All confirmed purely additive/forward-only (no `DROP`/`ALTER COLUMN TYPE`/
`TRUNCATE` in any file). Two files (`catalog_core`, `catalog_variants`) contain
a temporary `NO FORCE` → seed-insert → `FORCE ROW LEVEL SECURITY` toggle,
always restored within the same migration. `packages/db/test/migration.test.ts`
asserts the full chain applies in order and that `_catalog_realtime_company_scope`
is the last-applied migration. **Task 3.11 adds no migration.**

---

## 4. Permissions inventory

`catalog:view`, `catalog:manage`, `variants:manage`, `identifiers:manage`,
`pricing:manage`, `branch_price:manage`, `platform:tenants:view`,
`platform:tenants:manage`, `platform:catalog_capability:manage`,
`platform:plans:manage`, `platform:entitlements:manage`,
`platform:limits:manage`, `platform:audit:view`. Every mutating route carries
`@RequirePermission` (verified — no `@Public()` mutator exists). Two same-shape
routes gated by different permissions (product vs. variant tax-category;
UOM-registry vs. conversion-override writes) are deliberate, owner-documented
splits (O1), not gaps.

## 5. Capability inventory

The 16-key `CATALOG_CAPABILITY_KEYS` registry: `strategy.stocked`,
`strategy.bom`, `strategy.custom`, `variants`, `multi_uom`,
`identifiers.barcode_qr`, `branch_pricing`, `channel.pos`,
`channel.customer_web`, `inventory.tracked`, `inventory.lot_batch`,
`inventory.expiry`, `purchasing`, `production`, `delivery`,
`customer_ordering`. The last 6 are registered but unused by any Phase 3a
route — reserved for future phases.

## 6. Audit-action summary

`catalog.category_*`, `catalog.product_type_*`, `catalog.product_*`,
`catalog.attribute_definition_*`, `catalog.attribute_option_set_changed`,
`catalog.product_attributes_changed`, `catalog.variant_*`,
`catalog.option_group_*`, `catalog.option_value_set_changed`,
`catalog.identifier_*`, `catalog.uom_*`, `catalog.variant_conversions_changed`,
`catalog.product_conversions_changed`, `catalog.company_price_changed`,
`catalog.branch_price_changed`, `catalog.branch_availability_changed`,
`catalog.product_tax_category_changed`, `catalog.variant_tax_category_changed`,
`tenant.catalog_capability_changed`, `catalog.template_applied` (two
intentionally distinct reason shapes — initial apply vs. explicit re-apply).
Audit fires only on real mutation in every case except tax-category assign and
branch-availability set, which audit unconditionally on success by design
(documented, not a defect).

## 7. The exact 5 outbox/realtime events

`catalog.company.price_changed`, `catalog.branch.price_changed`,
`catalog.branch.availability_changed`, `catalog.product.status_changed`,
`catalog.variant.status_changed`. Status events fire only on
`visibilityChanged()` (`DRAFT↔ARCHIVED` never emits). All 5 are compile-time
protected via `satisfies CatalogEventType`.

---

## 8. Isolation verification

- **Tenant-scoped**: categories, product types, products, attributes,
  variants, identifiers, UOM — `ScopedRepository`/RLS, proven by
  `cross-tenant.probe.test.ts` (9 tests).
- **Company-scoped**: company pricing, tax-country authority
  (`company.countryCode`).
- **Branch-scoped**: branch price override, branch availability — proven by
  `branch-isolation.probe.test.ts` (10 tests).
- **Realtime**: tenant-global / company / branch scoping cumulative — proven
  by `gateway.integration.test.ts` + `resume.integration.test.ts`.
- Owner `ALL`/`ALL`, same-branch POS, and "POS terminal id is never an
  isolation axis" all explicitly tested.

## 9. RLS verification

Every Phase 3 tenant-owned table has `ENABLE`+`FORCE ROW LEVEL SECURITY` with
a `tenantId` policy: `tenant_catalog_capability`, `category`, `product_type`,
`product`, `attribute_definition`, `attribute_option`,
`product_attribute_value`, `option_group`, `option_value`, `variant`,
`variant_option_value`, `item_identifier`, `uom`, `uom_conversion`,
`company_variant_price_set`, `company_variant_uom_price`,
`branch_variant_price_set`, `branch_variant_uom_price`,
`branch_variant_availability`. `outbox` carries RLS via the Phase-1 dynamic
`tenant_tables` loop. Expected exceptions (no `tenantId` column, platform-
global): `business_type_template`, `business_type_template_capability`, and
the pre-existing `tax_category`/`country_tax_config`/`tax_rate` reference
tables. Zero `BYPASSRLS` in any catalog domain repository; `runPlatform` used
only in `catalog-capability.repository.ts` (the Platform Super-Admin surface,
by design).

## 10. Generic multi-business (ADR-0018) verification

**Zero violations.** No executable `businessType(Key)? ===`/`switch` branching
anywhere in `apps/`/`packages/` — every hit is a doc comment prohibiting the
pattern, a display-only provenance field, or an explicit "never read" comment.
`catalog-no-bt-branch.test.ts` structurally covers every domain file for tasks
3.2–3.10; it deliberately excludes `catalog-capability.*` (the template-apply
mechanism itself, ADR-0018's named exception).

**Dual-tenant behavioral proof — explicitly completed this task (owner
Decision 1):**

| Area                                                     | Existing proof?                                                                                                                           | Action taken                                                                                                                                                                                                                                                                                                                   |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Catalog core / attributes / variants / identifiers / UOM | Yes — already present (`catalog-core`, `catalog-attributes`, `catalog-variants`, `catalog-identifiers`, `catalog-uom` integration suites) | none — cited, not duplicated                                                                                                                                                                                                                                                                                                   |
| **Company pricing**                                      | Absent                                                                                                                                    | **Added**: `catalog-company-pricing.integration.test.ts` → _"two tenants, different businessTypeKey, identical company-pricing input -> identical results"_ — provisions a `BAKERY_CAKE`-preset tenant alongside the existing `CUSTOM` one, equalizes `multi_uom`, PUTs identical prices, asserts identical version/price/ETag |
| **Branch pricing**                                       | Absent                                                                                                                                    | **Added**: `catalog-branch-pricing.integration.test.ts` → _"two tenants, different businessTypeKey, identical branch-pricing input -> identical results"_ — same pattern, equalizes `multi_uom`+`branch_pricing`                                                                                                               |
| **Tax resolution**                                       | Absent                                                                                                                                    | **Added**: `catalog-tax.integration.test.ts` → _"two tenants, different businessTypeKey, identical product tax-category + date -> identical resolution"_ — both tenants resolve `STANDARD` at `2026-01-15`, compared excluding the per-request `companyId`/`variantId` fields                                                  |

All three new tests **passed on the first correct assertion** (an initial
`toEqual` on the tax test failed only because it compared per-request
`companyId`/`variantId` — fixed by excluding those two identifier fields; no
production code was touched). **No Business-Type-dependent behavior was
exposed.**

## 11. Concurrency/idempotency verification

Every mutable aggregate uses `If-Match`/version + a row lock (`FOR UPDATE`/
`FOR SHARE`/`FOR KEY SHARE`), except identifiers (immutable identity, still
lock-ordered). Idempotency-Key used where transport-replay risk exists
(product/variant lifecycle, identifier create/reactivate, UOM create, branch
availability, template re-apply); intentionally absent on pure-replace PUTs
(company/branch pricing, tax-category assign) since replace-set semantics make
replay safe by construction. No lost-update path found. No new concurrency
semantics were retrofitted.

## 12. Money/UOM verification

`Money` is `bigint` minor-units + currency + exponent — zero float arithmetic
anywhere in the path. Prices are always independently stored per-UOM tier,
never `base × factor` (ADR-0018 §5). UOM conversion ratios are exact `BigInt`
rationals; `Quantity` is a scale-4 exact bigint with a throwing `scaleByExact`
for pack snapshots. Pack identity (`packBaseQty`) is frozen at creation, never
re-derived — a corrupted stored value fails closed (500), never silently
drifts. **No inventory stock was implemented.**

## 13. Tax verification

Reconfirmed (35/35 tests green): `company.countryCode` sole fiscal authority;
product/variant precedence with NULL inheritance; both-NULL →
`NO_CATEGORY_ASSIGNED`; `REGIME_NONE` and a configured `rateBps:0` are three
distinct, never-conflated reasons; `?date=YYYY-MM-DD` civil date required, any
timestamp/timezone/instant → `400 INVALID_DATE`; pure `DATE`-cast SQL
comparison; `effectiveTo` inclusive; both `tax_rate` and `country_tax_config`
overlaps fail closed; no branch/POS timezone ever consulted. Task 2.7's
instant-based localization contract (`forCompany`) confirmed untouched and
separate.

## 14. Realtime/replay verification

Reconfirmed (all green): exactly the 5 event types; mutation+audit+outbox
co-committed in one transaction, no Redis call from the API mutation path;
company-/branch-filtered events scanned-but-undelivered with the cursor
advancing past them; reconnect-from-returned-cursor never re-delivers;
cumulative company+branch auth (both required when both present); mid-replay
scope narrowing takes effect immediately and deterministically; live and
replay share the identical `isAuthorized()`; expired/ahead-of-tail cursor →
`resync-required`.

## 15. Full regression/test counts

See §1's verification matrix. **Grand total across the workspace: 34/34 turbo
test tasks, exit 0**, with `@flower/api` alone at 537 passed tests across 40
files.

## 16. Final CI gate requirement

Task 3.11's PR must show **verify ✅ security ✅ e2e ✅ realtime ✅** on its own
PR-head CI run before merge, and again on an independent push-to-main CI run
on the exact merged commit before the `phase-3a-catalog-complete` tag is
created. Historical tags are never moved.

## 17. Accepted technical debt

Carried forward from Task 3.10 (re-confirmed, not reopened):
bounded ≤16-key sequential capability writes in `reapply()`; duplicated
outbox-payload/template-lookup code blocks (company/branch pricing;
product/variant status; `applyBusinessTypeTemplate`/`reapply` template
lookup); `IDEM_KEY_RE`/`KEY_RE` duplication; `reapply`'s Redis idempotency
pattern vs. `provisioning.service.ts`'s near-identical (unfingerprinted) one;
`entitledModules()` not parallelized with `reapply()`; the narrow concurrent-
fresh-key idempotency race (safe — the tenant-row `FOR UPDATE` lock prevents
any double mutation); `isAuthorized()`'s two structurally-parallel inline
scope-check blocks (style only, proven behaviorally correct). None of these
are Critical/High/correctness-or-security-Medium.

## 18. Intentionally deferred Phase 3b+ work

Per `PHASE-3-PLAN.md`'s "Explicitly OUT of Phase 3a" list: no
`inventory_item`, stock, BOM execution, orders, cart, checkout, payments,
AR/AP, accounting/GL, Z-Report, storefront, or promotions. `ADR-0019`
(customer receivables/settlement, doc-only) and `ADR-0020` (supplier
returns/credit, doc-only — confirmed this task to explicitly state Task 3.6
is unaffected and nothing in it is built during Phase 3a) both land with the
future Inventory/Purchasing/AR/AP work. `PHASE-2-BACKLOG.md` (B1–B13) remains
a separate, unrelated, still-open backlog per its own "re-check before every
later phase" instruction.

## 19. Scope statement

**This document certifies Phase 3a (catalog) completion only.** No
Inventory, Purchasing, BOM execution, Orders, Cart, Checkout, Payments,
Receivables, GL/Accounting, Z-Reports, WhatsApp, AI chatbot, media, frontend
(POS UI / Owner UI / Customer Web / Super Admin Web catalog screens),
workforce, or any Phase 3b work is implemented, started, or implied complete
by this document.

## 20. Required checkpoint tag

**`phase-3a-catalog-complete`** — an annotated tag, created only after this
task's docs/tests-only PR merges to `main` and an independent push-to-main CI
run is green on all four jobs for that exact commit. It is an **intermediate
checkpoint only** and must never be represented as "Phase 3 complete."
