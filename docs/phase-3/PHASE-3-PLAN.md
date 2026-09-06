# PHASE-3-PLAN.md — Phase 3 implementation plan (catalog foundation)

> **Status:** DRAFT — directionally approved (owner, 2026-09-05); amended with 15
> locked owner decisions (2026-09-06). **Not yet approved for merge.** Planning
> only — no runtime/domain code, no `schema.prisma` change, no migration is
> produced by this document.
>
> **Approved `main` at authoring:** `83ef2e18e3f47d18282008aaee8118990a32228a`
> (Task 3.0 — money/UOM completion pass, merged). Phase 0 / Phase 1 / Phase
> 2-core complete (`phase-0-complete` `c1ca217` · `phase-1-complete` `d44566b` ·
> `phase-2-core-complete` `a459858`).
>
> **Governing docs reconciled:** `ROADMAP.md` §Phase 3 · `ADR-0018` · `ADR-0019` ·
> `PHASE-2-BACKLOG.md` · `API-CONVENTIONS.md` · `DB-CONVENTIONS.md` ·
> `TESTING-STRATEGY.md` · `ARCHITECTURE.md` §4–5 / §15·17·18·19 / §42·43 / §45 /
> §48 / §48a / §F · `DOMAIN-MODEL.md` · `packages/money` · `packages/uom` · the
> current 47-model Prisma schema · `@flower/permissions` · the
> guard/entitlement/audit/outbox pipeline.

---

## 0. Locked decisions

### 0.1 Carried from Task 3.0 (preserve exactly)

**D0-1 — UOM cross-family conversion.** Generic/global conversion stays
family-safe (`LENGTH`/`MASS`/`VOLUME`/`COUNT` resolve via each unit's exact ratio
to the family base; `EACH` units have **no** generic conversion). Cross-family
conversions such as `roll → meter` or `bag → kg` are permitted **only** as
**explicit product- or variant-scoped** `uom_conversion` rows. **No unrestricted
global cross-family conversion table or rule is ever created.**

**D0-2 — Currency membership.** `@flower/money` remains a **pure arithmetic
currency superset** — GCC currencies + `USD` + `EUR` + any explicitly approved
arithmetic currency. The **DB `Currency` reference / configuration** determines
which currencies are actually **enabled / usable** by a company or a transaction.
Existence in `@flower/money` does **not** make a currency tenant/business enabled.
Any DB currency the platform actually uses **must** keep exponent parity with
`@flower/money` — the `packages/db` parity test (`gcc-reference-data.test.ts`)
stays build-blocking.

**D0-3 — Business Type presets.** Business Type is a **preset/template only**.
Runtime catalog behaviour **never** depends on `tenant.business_type_key` — no
`if flower … / if perfume … / if bakery …` branch anywhere
(HG3-NO-BT-BRANCH). No `FlowerProduct` / `BakeryProduct` / `PerfumeProduct` /
`GroceryProduct` … entity or code path. The initial curated preset set is fixed
in **Appendix A** (Jewellery/Accessories and Mobile/Mobile-Accessories
**excluded**).

### 0.2 Amendments locked 2026-09-06

**D2-1 — Phase 3a / 3b split (approved).**
`Phase 3a` = generic catalog / UOM / identifiers / pricing / tax-reference
foundation. `Phase 3b` = orders / payments / GL / receivables / settlement /
cancellation / refund / atomic walk-in sale. **`phase-3a-catalog-complete` is an
intermediate checkpoint tag only — it must NEVER be represented as full Phase 3
completion.** `phase-3-complete` may only be created after the **full Phase 3
roadmap exit criteria, including all of Phase 3b**, are satisfied.

**D2-2 — Catalog vs company vs branch scope (pricing architecture correction).**
The platform is `tenant → many companies → many branches`; companies may be in
different GCC countries and therefore use **different currencies / fiscal
profiles** (`company.country_code`, Task 2.7). Therefore:

| Layer                        | Scope                                                | Examples                                                                                                              |
| ---------------------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| **Catalog definition**       | **tenant-scoped, company-neutral, currency-neutral** | `product`, `category`, `product_type`, `attribute_definition`, `variant`, `item_identifier`, `uom`, `uom_conversion`  |
| **Commercial configuration** | **company-scoped** (by default)                      | `company_variant_uom_price` (sell + purchase/cost-path Money), tax-category rate context (via `company.country_code`) |
| **Branch overrides**         | **branch-scoped**                                    | `branch_variant_uom_price` (price override), `branch_variant_availability` (merchandising flag)                       |
| **Stock**                    | **branch-scoped — Phase 5 only**                     | `branch_inventory_balance`, `inventory_movement`, `stock_reservation` — **not in Phase 3**                            |

- **`variant` itself stays price/currency-neutral** — it carries **no** monetary
  selling price and **no** currency. (One tenant may hold an AED company and a
  SAR company sharing the same `variant`.)
- **Pricing = two explicit tables** (D2-3), **not** nullable-`branch_id`
  overloading.
- **Price-resolution precedence:** `branch UOM override → company UOM default →
no valid price / explicit domain result`. **Never** a fall-back to an
  unrelated tenant-wide currency price.
- A `branch_variant_uom_price` row's `branch_id` **must** belong to the same
  `company_id` — enforced by an FK path + a service check.
- **Mandatory acceptance test (HG3-COMPANY-PRICE):** one tenant, a UAE company
  (AED pricing) and a Saudi company (SAR pricing), **the same catalog variant
  shared**, **no currency/pricing leakage** between the two companies, a branch
  override affects **only** its own branch/company.

**D2-3 — Two pricing tables** — `company_variant_uom_price` +
`branch_variant_uom_price` (schema in §C.8 / §C.9). This mirrors the conceptual
separation `tenant catalog definition ≠ company commercial defaults ≠ branch
commercial override ≠ branch stock` and avoids nullable-scope uniqueness
ambiguity.

**D2-4 — Business Type template semantics.** Template application **copies /
snapshots** template defaults into the tenant's own capability rows. A later
edit to a platform-global `business_type_template` **must not** silently change
existing tenants (HG3-TEMPLATE-SNAPSHOT). Each capability row records: the source
template key, the source template **version**, `applied_at`, and (where
appropriate) `applied_by`. Tenant capability rows are the **runtime
configuration**. A deliberate Super-Admin re-apply of a newer template is an
**explicit, audited** operation with clear replace/merge semantics — **never** an
automatic background mutation.

**D2-5 — Capability storage is normalized** (rejects the old "one JSON row per
tenant"). One row per `(tenant_id, capability_key)`; a bounded config `jsonb`
column **only** where a capability genuinely needs structured configuration;
source/template metadata; `version` + timestamps. Business-Type preset
capabilities are likewise structurally queryable/versionable, not an opaque
blob where practical (HG3-CAPABILITY-NORMALIZATION). **Four distinct layers, all
applied:** `Entitlement ≠ Catalog Capability ≠ Permission ≠ Business Type
Template`. Effective access is constrained by **every** applicable layer. **A
Business Type template never grants a billing entitlement by itself.**

**D2-6 — Permission-key stability.** An existing stable permission key is
**never** renamed or duplicated to change its grouping. `identifiers:manage`
stays the one canonical identifier-management key (in its current `inventory`
group — grouping is display metadata, unrelated to which routes use it). Only
`platform:catalog_capability:manage` is **added** (platform realm, step-up).
No two semantically identical identifier permissions (HG3-PERMISSION-STABILITY).

**D2-7 — Product media deferred.** No arbitrary product-media `jsonb` on the
`product` row. Phase 3a catalog definitions may exist with **no** media. Media
is introduced with the proper file/media foundation (Phase 5 `files` /
`documents`), using explicit media references with ownership, ordering and
lifecycle rules.

**D2-8 — Tax scope.** Phase 3a: **tax-category assignment** on the catalog +
**`company.country_code`-based effective-rate resolution** (a read service).
**No** sale/cart/order tax computation in Phase 3a. Phase 3b: line/order tax
calculation, inclusive/exclusive rules, rounding policy, tax snapshots on
financial transactions.

**D2-9 — Idempotency vs optimistic concurrency contract.**

- POST / create / command / action endpoints → **`Idempotency-Key`**.
- Versioned `PUT` / `PATCH` (a field-level update of an aggregate that carries a
  `version`) → **`If-Match` / expected version** (`409` on mismatch).
- Replace-set `PUT` operations → **require the parent `If-Match`**; add
  `Idempotency-Key` **only** when the operation has non-idempotent external or
  multi-command side effects that need replay semantics.
- **Not** both, mechanically, on every simple update.

**D2-10 — Audit scope (Phase 3a minimum).** Audit — via the **existing**
`AuditWriter` / `AUDITABLE_ACTIONS` registry, **no second audit system**:
Business-Type / template application · tenant catalog-capability changes ·
product status changes · variant status changes · identifier
creation/change/removal · UOM / conversion configuration changes · company price
changes · branch price override changes · branch availability changes ·
tax-category assignment changes.

**D2-11 — No inventory shell in Phase 3a.** No `inventory_item` / stock /
movement / reservation shell table. Those are Phase 5. Catalog availability is a
**boolean / configuration state only** and is never used as a stock quantity
(HG3-CATALOG-SCOPE-SEPARATION).

**D2-12 — Migration wording.** Phase 3a may make **strictly additive** changes
to a shipped Phase 0/1/2 table (a nullable column, e.g. `tenant.business_type_key`
and its template metadata) when approved. The rule is:

- **no destructive rewrite** of shipped Phase 0/1/2 schema;
- **additive / expand-only** migration is allowed; **nullable / additive first**;
- **forward-only**;
- **migration-baseline Testcontainers tests mandatory** for any task that
  changes schema.

**Not every Task 3.x creates a migration** — only a task that requires a schema
change does (§B notes which).

---

## A. Phase 3 architecture summary

### A.1 What `ROADMAP.md` §Phase 3 fixes

Phase 3 is _"Catalog, tax, orders, POS walk-in sale, payments, double-entry GL,
receivables — first revenue path + financial truth"_. Modules: `catalog ·
identifiers · pricing(basic) · tax · orders · payments · accounting (CoA +
posting engine + periods) · receivables (AR / credit / advances / gift cards) ·
crm(core) · files · reporting(first rollups)`. Exit criteria: a full
cash/card/credit/advance walk-in sale posts correct balanced GL entries; trial
balance ties; Owner figures reconcile to the GL. ADR-0018 (catalog capability +
per-UOM pricing) and ADR-0019 Part A + B are **additive Phase 3 scope** per the
roadmap's own dated notes. **This plan executes Phase 3 as 3a then 3b** (D2-1);
dependency order and exit criteria are unchanged, only the planning is staged.

### A.2 Scope of _this_ plan — Phase 3a (catalog foundation)

Money/UOM (Task 3.0, done) → catalog capability & Business-Type template
configuration → the one generic catalog core (categories, product types, typed
attributes, variants, identifiers) → UOM configuration + item/variant
conversions → **company** per-UOM sale pricing + a purchase/cost-path foundation
→ **branch** price override + branch availability → tax-category + rate
resolution → template application + catalog realtime → a verification pass and
the **`phase-3a-catalog-complete` checkpoint tag** (D2-1 — never "Phase 3
complete").

**Phase 3b** — orders, tax computation on a sale, payments + one provider
adapter, the double-entry GL + posting engine, receivables/credit/advances,
customer settlement + allocation + settlement discount, cancellation + refund +
cancellation charge, the atomic walk-in sale, first reporting rollups — is a
**separate plan** written after `phase-3a-catalog-complete` is tagged. This plan
gives Phase 3b a high-level task outline (§H.3) and the ADR-0019 structural
constraints (§H.2) that Phase 3a must not paint into a corner; **no** Phase 3b
task is detailed, scheduled, or implemented here.

### A.3 One generic catalog core (ADR-0018, binding)

A **single** `product → category → product_type/behaviour → typed attributes →
variant → identifier (SKU/BARCODE/QR) → base UOM → conversion UOMs → company
per-UOM price → branch price/availability` pipeline serves **every** business
type. In one tenant's catalog a flower shop sells, in the same catalog: flowers,
bouquets, chocolates, perfumes, toys, balloons, cakes, plants, gift boxes,
hampers, normal retail products — through the same catalog, the same
cart/invoice model (Phase 3b), and (Phase 5) the same inventory engine.

- **No** `FlowerProduct` / `PerfumeProduct` / `BakeryProduct` / `GroceryProduct`
  entity, table, service, or code path. **No** per-business-type inventory or
  pricing engine.
- Product behaviour is driven **only** by `fulfilment_strategy`
  (`STOCKED · BOM · CUSTOM`), enabled capabilities, and configured data.
- Vertical variation (perfume volume, stem count, shelf-life) is a **typed
  attribute value**, never a nullable column on `product`/`variant`
  (`ARCHITECTURE.md` §15; ADR-0018 §6).
- **Mixed-cart** is a binding acceptance requirement (Phase 3b tests). Phase
  3a's contribution: the catalog model is category- and business-type-neutral by
  construction.

### A.4 Four distinct concepts — never conflated (D2-2)

| Concept                       | What it is                                                                                                        | Scope                                              | Phase                       |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- | --------------------------- |
| **Catalog definition**        | product / category / attribute / variant / identifier / base-UOM / conversion — _what exists to sell_             | **tenant** — company-neutral, **currency-neutral** | 3a                          |
| **Company commercial config** | the company's per-UOM **sell price** (and a nullable purchase/cost-path) for a variant, in the company's currency | **tenant + company**                               | 3a                          |
| **Branch overrides**          | a branch's per-UOM price override; a branch's merchandising **availability flag** (a boolean, **not** a quantity) | **tenant + company + branch**                      | 3a                          |
| **Branch stock**              | on-hand / reserved / available **quantity** at the branch                                                         | tenant + branch                                    | **5 — NOT Phase 3** (D2-11) |

**Branch stock is never catalog truth.** A variant is offered at a branch
because `branch_variant_availability.available` (default: available wherever the
owning company prices the variant) — **not** because stock exists. Phase 5 layers
real availability (`AvailabilityService` over `branch_inventory_balance` +
reservations) on top; the Phase 3a flag becomes the "is it merchandised here"
gate Phase 5's quantity check runs _inside_.

### A.5 Money / UOM — Task 3.0 packages are authoritative

Every Phase 3 model and API **reuses** `@flower/money` and `@flower/uom`. No
floating point for money. **No duplicated currency-exponent logic** and **no
duplicated UOM conversion arithmetic** in any API/domain module — the domain
calls `Money` / `Quantity` / `UomRegistry`. **`variant` carries no price and no
currency** (D2-2). Column ↔ value-object mapping: §C.10. DTO wire shapes are
locked (Task 3.0): money = `{ amountMinor: string, currency, exponent }`;
quantity = `{ amount: string }` with the UOM code carried **separately** in the
payload; controllers import `moneyDtoSchema` / `quantityDtoSchema` from
`@flower/shared-types`.

### A.6 Capabilities & Super Admin (ADR-0018 §2 / §7, binding; D2-5)

Super Admin controls, **per tenant**, which catalog capabilities / modules /
templates are available (the **entitlement axis**). Owner / Admin / Manager then
create and manage business data **within** what is available, constrained by
**all four** axes (entitlement → permission → company scope → branch scope) **and**
the fine `tenant_catalog_capability` config. A Flower Shop tenant may enable any
combination of capabilities (gifts, chocolates, perfume, cakes, balloons,
plants…). Owner/Admin/POS **never** gain write access to the
capability-configuration surface. **A Business Type template never grants a
billing entitlement.**

### A.7 Realtime / outbox — reuse the Phase 2-core pipeline

Catalog changes that must reach same-branch POS clients live use the **existing**
`DB transaction → outbox row (same txn) → Task 2.4 dispatcher → rt:stream:{tenant}
→ Task 2.5 relay → rt:live:{tenant} Pub/Sub → Task 2.6 gateway → authorized
branch sockets` path. **No second realtime architecture.** Events stay
tenant-isolated, branch-authorized, `event_id`-deduped, resumable via the
existing cursor protocol (ADR-0017). Only genuinely useful, low-volume events
are published (§F).

### A.8 Localization / fiscal — reuse Task 2.7 (D2-8)

Phase 3 reuses Task 2.7's `company.country_code`-driven fiscal foundation, the
`Country` / `Currency` / `CountryTaxConfig` / `TaxCategory` / `TaxRate` reference
tables, and `LocalizationService`. **No** currency-exponent, country fiscal
profile, or VAT-regime table is duplicated. Phase 3a adds only: a
**`tax_category` reference on the catalog** (product/variant → VAT category) and
a **`TaxResolutionService`** (category + `company.country_code` + date → the
applicable effective `TaxRate`). **No** tax computation on an amount in Phase 3a
— that (line/order tax, inclusive/exclusive, rounding, snapshots) is Phase 3b.

---

## B. Task 3.x sequence (Phase 3a)

Each task: its own `phase-3/3.x-<slug>` branch, one verified commit, `main`
always green, PR with the full CI gate (`verify` + `security` + `e2e` +
`realtime`), **STOP and report before the next task**, proceed only on a fresh
owner instruction. A task that changes schema ships **one additive forward-only
expand migration** (D2-12 — additive to an existing Phase 0/1/2 table is allowed
for a nullable column only), extends `TENANT_SCOPED_TABLES` /
`PLATFORM_GLOBAL_TABLES` in `packages/db` + the schema-baseline + RLS-coverage
Testcontainers tests, and adds RLS `ENABLE + FORCE` + policy on every new
tenant-owned table.

| Task     | Title                                                                                | Schema                                                                                                                                                                     |        Migration?        | Depends on    |
| -------- | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :----------------------: | ------------- |
| **3.0**  | Money / UOM completion pass                                                          | packages only — **DONE** `83ef2e1`                                                                                                                                         |            no            | —             |
| **3.1**  | Catalog capability & Business-Type template foundation                               | `business_type_template` (platform-global) · `tenant_catalog_capability` (normalized) · `tenant.business_type_key` + template metadata (**additive nullable** on `tenant`) |           yes            | 3.0           |
| **3.2**  | Generic catalog core — categories, product types, products                           | `category` · `product_type` · `product`                                                                                                                                    |           yes            | 3.1           |
| **3.3**  | Typed attribute templates + values                                                   | `attribute_definition` · `attribute_option` · `product_attribute_value`                                                                                                    |           yes            | 3.2           |
| **3.4**  | Variants + option groups                                                             | `option_group` · `option_value` · `variant` · `variant_option_value`                                                                                                       |           yes            | 3.3           |
| **3.5**  | Identifiers — SKU / barcode / QR                                                     | `item_identifier`                                                                                                                                                          |           yes            | 3.4           |
| **3.6**  | UOM configuration + item/variant conversions                                         | `uom` · `uom_conversion` · `variant.base_uom_code` (additive on `variant`)                                                                                                 |           yes            | 3.4           |
| **3.7**  | **Company** per-UOM sale pricing + purchase/cost-path foundation                     | `company_variant_uom_price` (`sell_*` populated; `purchase_*` nullable/foundation-only)                                                                                    |           yes            | 3.6           |
| **3.8**  | **Branch** price override + branch availability                                      | `branch_variant_uom_price` · `branch_variant_availability`                                                                                                                 |           yes            | 3.7           |
| **3.9**  | Tax category on the catalog + rate-resolution service                                | `product.tax_category_key` / `variant.tax_category_key` (additive) · `TaxResolutionService` — **no new table**                                                             | yes (2 additive columns) | 3.2, Task 2.7 |
| **3.10** | Business-Type template application + catalog realtime                                | template-apply transaction + `catalog.*` outbox events                                                                                                                     |          **no**          | 3.1–3.9       |
| **3.11** | Phase 3a verification pass + `PHASE-3A-RESULTS.md` + `phase-3a-catalog-complete` tag | —                                                                                                                                                                          |          **no**          | 3.1–3.10      |

Order rationale: capability gating exists **before** any catalog create-endpoint
(3.1 first); the pipeline is built bottom-up; **company** pricing (3.7) precedes
**branch** overrides (3.8) — matching the resolution precedence and D2-2's scope
separation; tax is a thin catalog annotation + a read service (3.9); realtime +
template application land together (3.10, no schema); verification last (3.11).
Tasks 3.5 and 3.6 both depend only on 3.4 and may be interleaved.

---

## C. Schema / RLS matrix (proposed — no migration written here)

**Conventions applied to every row** (DB-CONVENTIONS): `id uuid` default
`uuidv7()`; `created_at` / `updated_at timestamptz` UTC; extensible
kind/status/behaviour columns are `text` + a `CHECK` against a documented
allow-list, **never** a PG `enum`; composite indexes lead with `tenant_id` then
`company_id` / `branch_id` then the query key; every FK is indexed; money =
`<x>_amount_minor bigint` + `<x>_currency_code text` + `<x>_currency_exponent
smallint`; quantity = `numeric(18,4)`; `version int` on an aggregate that
supports `If-Match`. **Soft-delete:** catalog-definition rows use a `status`
lifecycle (`DRAFT · ACTIVE · ARCHIVED`); **no hard delete** of an `ACTIVE` /
`ARCHIVED` row (a Phase 3b order-line snapshot, a Phase 5 movement, a Phase 6
recipe may reference it); a `DRAFT` row may be hard-deleted (gated + audited).
Override rows (`branch_variant_*`) may be hard-deleted (audited) — they are pure
overrides. **Migration rule: D2-12** (additive-only; a nullable column may be
added to `tenant` / `variant`; forward-only; baseline tests mandatory).

### C.1 `business_type_template` — platform-global reference (RLS-exempt)

| Col                   | Type / rule                                                                                                                                                                                                        |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `key`                 | `text` PK — one of **Appendix A** (Jewellery/Mobile excluded)                                                                                                                                                      |
| `version`             | `int NOT NULL` — bumped on any curated edit; a tenant records the version it was applied from (D2-4)                                                                                                               |
| `name_en` / `name_ar` | display                                                                                                                                                                                                            |
| `template_payload`    | `jsonb` — **structured**: suggested categories, attribute templates, variant templates, UOM templates, recommended capability preset (a list of `{ capability_key, enabled, config? }`, not an opaque blob — D2-5) |
| `status`              | `ACTIVE` / `DEPRECATED`                                                                                                                                                                                            |

RLS: **exempt** (like `country` / `currency`). `flower_app` **SELECT-only**;
writes via the platform/seed path. Curated seed data (Task 3.1 proposes the
concrete payloads for sign-off).

### C.2 `tenant_catalog_capability` — normalized (D2-5), tenant-scoped

| Col                       | Type / rule                                                                                                                                                                                                                                                   |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id` / `tenant_id`        | tenant-owned                                                                                                                                                                                                                                                  |
| `capability_key`          | `text` — e.g. `strategy.STOCKED`, `strategy.BOM`, `strategy.CUSTOM`, `lot_batch`, `expiry`, `production_bom`, `custom_composition`, `pos_visible`, `customer_web_visible`, `category_template.<key>`, `uom_template.<key>` … (Task 3.1 fixes the closed list) |
| `enabled`                 | `boolean NOT NULL`                                                                                                                                                                                                                                            |
| `config`                  | `jsonb` **nullable** — bounded config **only** where a capability genuinely needs structure                                                                                                                                                                   |
| `source_template_key`     | `text` nullable — FK-style ref to `business_type_template.key`                                                                                                                                                                                                |
| `source_template_version` | `int` nullable — the version snapshotted (D2-4)                                                                                                                                                                                                               |
| `applied_at`              | `timestamptz` nullable · `applied_by` `text` nullable (platform user id)                                                                                                                                                                                      |
| `version`                 | `int` · `created_at` / `updated_at`                                                                                                                                                                                                                           |

**Unique `(tenant_id, capability_key)`** (HG3-CAPABILITY-NORMALIZATION). Index
`(tenant_id)`. **RLS `ENABLE + FORCE`** + tenant policy. **Super-Admin (platform
realm, step-up) write only** — no tenant permission key reaches it (mirrors
`provider_credential`). Owner / catalog module **read** (`catalog:view`). A
single write of one capability **cannot** overwrite unrelated capability rows.

**`tenant.business_type_key`** — additive nullable column on the existing `tenant`
table (FK → `business_type_template.key`, `ON DELETE RESTRICT`); plus additive
nullable `tenant.business_type_applied_version int` / `business_type_applied_at
timestamptz`. Inherits `tenant` RLS (policy keys on `id`). **Never read at
runtime to branch behaviour** (D0-3) — used only to pick a template at
apply-time. No retype of any existing `tenant` column (D2-12).

**Entitlement modules** (`@flower/shared-types` `ENTITLEMENT_MODULES`,
`entitlement_default`, `tenant_entitlement`): add `custom_composition` (a new
§48-style toggle, alongside `production_bom`); mark `catalog` a **foundation
module** (always entitled, not toggleable). The **coarse module** is enforced by
the guard pipeline (`policy-engine.ts` step 5); the **fine capability** by the
catalog **service** at write time (ADR-0018 §2).

### C.3 Task 3.2 — catalog core (tenant-scoped, company-neutral)

| Table          | RLS          | Unique                         | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| -------------- | ------------ | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `category`     | ENABLE+FORCE | `(tenant_id, parent_id, slug)` | self-ref `parent_id` (nullable = root); `name_en`/`name_ar`; `sort_order`; `status` (`ACTIVE`/`ARCHIVED`). Company-neutral.                                                                                                                                                                                                                                                                                                                                  |
| `product_type` | ENABLE+FORCE | `(tenant_id, key)`             | a behaviour/attribute bundle (`PERFUME`, `CUT_FLOWER`, `CAKE`, `GENERAL` …) that scopes which attribute definitions apply. **Descriptive metadata only** — behaviour is `fulfilment_strategy`, never `product_type`.                                                                                                                                                                                                                                         |
| `product`      | ENABLE+FORCE | `(tenant_id, slug)`            | `category_id` FK; `product_type_id` FK nullable; `fulfilment_strategy text CHECK (∈ STOCKED,BOM,CUSTOM)` (create rejected by the service if the strategy is not enabled in `tenant_catalog_capability`); `name_en`/`name_ar`, `description`; `hide_price boolean default false`; `status` (`DRAFT`/`ACTIVE`/`ARCHIVED`); `version int`. **No `media` column** (D2-7). Indexes `(tenant_id, category_id)`, `(tenant_id, status)`, `pg_trgm` GIN on `name_en`. |

### C.4 Task 3.3 — typed attributes (tenant-scoped)

| Table                     | RLS          | Unique                                             | Notes                                                                                                                                                                                                                                                     |
| ------------------------- | ------------ | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `attribute_definition`    | ENABLE+FORCE | `(tenant_id, key)`                                 | `value_type text CHECK (∈ TEXT, NUMBER, ENUM, BOOLEAN, DATE)` — **closed** set (ADR-0018 risk 3, no arbitrary JSON); `applies_to` (nullable `category_id`/`product_type_id`); `unit_hint text` nullable; `is_variant_option boolean`; `required boolean`. |
| `attribute_option`        | ENABLE+FORCE | `(tenant_id, attribute_definition_id, value)`      | `value_type = ENUM` only; `label_en`/`label_ar`, `sort_order`.                                                                                                                                                                                            |
| `product_attribute_value` | ENABLE+FORCE | `(tenant_id, product_id, attribute_definition_id)` | typed columns `value_text` / `value_number numeric` / `value_bool boolean` / `value_date date` / `option_id` — a `CHECK` enforces exactly one populated per `value_type`.                                                                                 |

### C.5 Task 3.4 — variants (tenant-scoped) — **price/currency-neutral (D2-2)**

| Table                  | RLS          | Unique                                     | Notes                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------------- | ------------ | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `option_group`         | ENABLE+FORCE | `(tenant_id, product_id, key)`             | `SIZE`, `COLOUR`, `STYLE`, `OCCASION` …; `name_en`/`name_ar`, `sort_order`.                                                                                                                                                                                                                                                                                                                                           |
| `option_value`         | ENABLE+FORCE | `(tenant_id, option_group_id, value)`      | `label_en`/`label_ar`, `sort_order`.                                                                                                                                                                                                                                                                                                                                                                                  |
| `variant`              | ENABLE+FORCE | `(tenant_id, sku)` where `sku` not null    | `product_id` FK; `sku text` nullable (numbering service / manual); `name_en` (denormalised); `base_uom_code text` (added Task 3.6, nullable → `NOT NULL`); `status` (`DRAFT`/`ACTIVE`/`ARCHIVED`); `version int`. **No price, no currency column — ever.** A `CUSTOM`-strategy product may have **zero** variants (composition captured at sale — Phase 6). Indexes `(tenant_id, product_id)`, `(tenant_id, status)`. |
| `variant_option_value` | ENABLE+FORCE | `(tenant_id, variant_id, option_group_id)` | the concrete option selection; FK → `option_value`.                                                                                                                                                                                                                                                                                                                                                                   |

### C.6 Task 3.5 — identifiers (tenant-scoped)

| Table             | RLS          | Unique                              | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ----------------- | ------------ | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `item_identifier` | ENABLE+FORCE | **`(tenant_id, code_type, value)`** | `target_kind text CHECK (∈ VARIANT, INVENTORY_ITEM)` — `INVENTORY_ITEM` is a **reserved forward value** (no `inventory_item` table in Phase 3a — D2-11; a Phase-3a identifier always targets a `VARIANT`); `target_id uuid`; `code_type text CHECK (∈ SKU, BARCODE, QR)`; `value text`; `pack_uom_code text` + `pack_qty numeric(18,4)` nullable (a per-pack-level identifier, e.g. a box-of-12 barcode); `status` (`ACTIVE`/`INACTIVE`). Indexes `(tenant_id, target_kind, target_id)`, `(tenant_id, value)`. |

### C.7 Task 3.6 — UOM configuration + conversions (tenant-scoped)

| Table                   | RLS                          | Unique                                                          | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------------- | ---------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `uom`                   | ENABLE+FORCE                 | `(tenant_id, code)`                                             | `family text CHECK (∈ LENGTH, MASS, VOLUME, COUNT, EACH)` (mirrors `@flower/uom` `UomFamily`); `per_base_num bigint` / `per_base_den bigint` (both `> 0`, `CHECK`); `max_decimals smallint CHECK (0..4)` **with `CHECK (family <> 'COUNT' OR max_decimals = 0)`** (D0-1 — COUNT discrete); `name_en`/`name_ar`. Built-in units come from `@flower/uom`'s `BUILTIN` — a `uom` row is only for a **tenant-specific** unit (a foam block, a 25 kg bag).   |
| `uom_conversion`        | ENABLE+FORCE                 | `(tenant_id, scope_kind, scope_id, from_uom_code, to_uom_code)` | **product/variant-scoped only** (D0-1): `scope_kind text CHECK (∈ VARIANT, PRODUCT)`, `scope_id uuid`; `from_uom_code` / `to_uom_code` (a `@flower/uom` built-in or a registered tenant `uom` — validated against `UomRegistry`); `num bigint` / `den bigint` (`> 0`, `CHECK`). A row **may** cross families (e.g. `roll → meter`, `bag → kg`) **because it is scoped to one variant/product** — **there is no `GLOBAL` scope value** (schema + test). |
| `variant.base_uom_code` | additive column on `variant` | —                                                               | the canonical base UOM; every price and every future stock quantity normalises to it. Populated Task 3.6, then `NOT NULL`.                                                                                                                                                                                                                                                                                                                             |

**Domain wiring (no arithmetic re-implemented):** the catalog service builds a
`UomRegistry({ units, conversions })` from `@flower/uom` and calls
`registry.convert(...)` / `registry.assertPermitted(...)`. Task 3.0's eager
validation (num/den > 0, referenced units registered, COUNT discrete) runs at
registry construction and is surfaced as a `422` on a bad `uom` /
`uom_conversion` write.

### C.8 Task 3.7 — `company_variant_uom_price` (tenant + **company**)

| Col                                                                                  | Type / rule                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id` / `tenant_id` / `company_id`                                                    | tenant-owned; `company_id` FK → `company`                                                                                                                                                                                                                                           |
| `variant_id`                                                                         | FK → `variant`                                                                                                                                                                                                                                                                      |
| `uom_code`                                                                           | the variant's `base_uom_code` **or** a UOM reachable from it via a `uom_conversion` (validated)                                                                                                                                                                                     |
| `sell_amount_minor` / `sell_currency_code` / `sell_currency_exponent`                | the **company's selling price for this UOM tier** — an **independent stored value**, **not** `base_price × factor` (D0-1 / ADR-0018 §5). `sell_currency_code` **must** be the company's `default_currency` and a **DB-enabled** currency (D0-2); a cross-currency price is a `422`. |
| `purchase_amount_minor?` / `purchase_currency_code?` / `purchase_currency_exponent?` | **foundation-only — nullable, may be written by an Owner but consumed nowhere in Phase 3**; Phase 5 procurement wires it. Its presence now means Phase 5 needs **no** schema change for UOM-specific cost.                                                                          |
| `version` / `created_at` / `updated_at`                                              |                                                                                                                                                                                                                                                                                     |

**Unique `(tenant_id, company_id, variant_id, uom_code)`.** Index
`(tenant_id, company_id, variant_id)`. RLS `ENABLE + FORCE` + tenant policy;
**company scope** enforced by the guard pipeline's company-scope step + the
service filtering on `company_id`. **The base-UOM price is the always-present
default per company** — a variant cannot be `ACTIVE` for sale by a company until
that company has at least a `(…, variant, base_uom_code)` row.

**Price-resolution service (Task 3.7 / consumed in 3b):** given
`(company_id, variant_id, uom_code, branch_id?)` → the effective `Money` sell
price. Precedence (D2-2):

```
branch_variant_uom_price  (matching branch_id + uom_code)
    → company_variant_uom_price  (matching company_id + uom_code)
    → no valid price / an explicit domain result (422 / a typed "unpriced")
```

**Never** a fall-back to a tenant-wide or another company's currency price. If
the requested `uom_code` has no explicit row at either level, the result is an
explicit "no price" — Phase 3 never derives a per-UOM price by multiplication.

### C.9 Task 3.8 — `branch_variant_uom_price` + `branch_variant_availability` (tenant + company + **branch**)

| Table                         | RLS                                                    | Unique                                                     | Notes                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------------------- | ------------------------------------------------------ | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `branch_variant_uom_price`    | ENABLE+FORCE (+ branch GUC filter where single-branch) | `(tenant_id, company_id, branch_id, variant_id, uom_code)` | `branch_id` FK → `branch`; **the branch must belong to `company_id`** (FK path + a service check); `override_amount_minor` / `override_currency_code` / `override_currency_exponent` (same currency as the company); `version` / timestamps. Deletable (audited) — a pure override. Gated by `branch_price:manage`, `@ScopedParam({ branch: 'branchId' })`.            |
| `branch_variant_availability` | ENABLE+FORCE (+ branch GUC filter)                     | `(tenant_id, company_id, branch_id, variant_id)`           | `available boolean NOT NULL` — a **merchandising flag**, **not** a quantity (D2-11 / HG3-CATALOG-SCOPE-SEPARATION). Absence of a row = **available** wherever the owning company prices the variant. `branch_id` must belong to `company_id`. Gated by `branch_price:manage`, `@ScopedParam`. Indexes `(tenant_id, company_id, branch_id)`, `(tenant_id, variant_id)`. |

### C.10 Money / UOM ↔ column mapping (binding)

| Value object | Columns                                                                                 | Read                                                                                                                                                                                                    | Write                                                                                                                                                                                                                                                                                 |
| ------------ | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Money`      | `<x>_amount_minor bigint` · `<x>_currency_code text` · `<x>_currency_exponent smallint` | `Money.ofMinor(BigInt(row.x_amount_minor), row.x_currency_code)` — the `_exponent` column is a wire convenience, **not** trusted for arithmetic; it **must** equal `currencyExponent(x_currency_code)`. | from `money.toDTO()` → the three columns; the write asserts the currency is a **DB-enabled currency for the company** (D0-2), not merely known to `@flower/money`, and (for a price) equals the company's `default_currency`. Optional `CHECK (x_currency_exponent BETWEEN 0 AND 3)`. |
| `Quantity`   | `<x> numeric(18,4)`                                                                     | `Quantity.parse(row.x.toString())` (Prisma `Decimal`)                                                                                                                                                   | `quantity.toFixed4()` → the `numeric(18,4)` column. `@flower/uom`'s `QUANTITY_MAX/MIN_SCALED` (`±(10^18−1)`) = exactly `numeric(18,4)`'s range.                                                                                                                                       |
| tax rate     | `rate_bps int` (reuses Task 2.7 `tax_rate.rate_bps`)                                    | —                                                                                                                                                                                                       | `Money.percentage(rate_bps)` — **Phase 3b** only (D2-8).                                                                                                                                                                                                                              |

### C.11 Migration & baseline rules (D2-12)

- **No destructive rewrite** of any Phase 0/1/2 table. **Additive / expand-only**
  is allowed — a **nullable** column on `tenant` (`business_type_key`,
  `business_type_applied_*`) and later on `variant` (`base_uom_code`,
  nullable → `NOT NULL` in a follow-up step). Forward-only. Nullable/additive
  first.
- **Migration-baseline Testcontainers tests are mandatory** for every
  schema-changing task; each extends `packages/db/src/constants.ts`
  (`TENANT_SCOPED_TABLES` / `PLATFORM_GLOBAL_TABLES`), the schema-baseline
  assertion, and the RLS-coverage test.
- **`business_type_template`** is the only Phase 3a platform-global (RLS-exempt)
  table; every other new table is tenant-owned with `ENABLE + FORCE` +
  `USING (tenant_id = nullif(current_setting('app.tenant_id', true),'')::uuid)` +
  matching `WITH CHECK`.
- **Partitioning:** no Phase 3a table is high-volume append-only — **none is
  partitioned**. (`DB-CONVENTIONS.md` / `DOMAIN-MODEL.md` "Partitioning (from
  migration #1)" is factually stale — Phase 1's migration #1 created none of
  `order` / `journal_*`, and `idempotency_key` was de-partitioned in Task 2.1;
  Task 3.1 amends the wording — §K. Phase 3b decides `order` / `journal_*`
  partitioning at creation.)
- **`inventory_item` is not created in Phase 3a** (D2-11). Phase 5 adds it +
  `variant.inventory_item_id` as an additive migration;
  `item_identifier.target_kind` already reserves `INVENTORY_ITEM`.
- **Not every Task 3.x has a migration** — 3.10 and 3.11 do not.

---

## D. API matrix (Phase 3a)

All routes are `/v1/...`, go through the **existing** guard pipeline (auth →
tenant-from-session → entitlement → permission (+ step-up) → company scope →
branch scope → resource → business rule → txn → audit-via-outbox), and declare
`@RequirePermission(...)` **or** `@Public()` (neither → lint fails, CLAUDE.md
rule 9). Money/quantity bodies use the locked DTO shapes (§C.10). List endpoints
inject a scope filter, never reject. **Concurrency contract: D2-9.**

| Task | Method + path                                                                                                                                                                                                          | Permission                                                   | Scope                                        | Concurrency                                                                                                                                                                                                                                           |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 3.1  | `GET /v1/platform/business-type-templates`                                                                                                                                                                             | `platform:tenants:view` (platform)                           | —                                            | —                                                                                                                                                                                                                                                     |
| 3.1  | `PUT /v1/platform/tenants/:tenantId/catalog-capability`                                                                                                                                                                | `platform:catalog_capability:manage` (platform, **step-up**) | —                                            | `Idempotency-Key` (`catalog.capability.set`) — an action with a template-snapshot side effect                                                                                                                                                         |
| 3.1  | `GET /v1/catalog/capability`                                                                                                                                                                                           | `catalog:view`                                               | tenant                                       | —                                                                                                                                                                                                                                                     |
| 3.2  | `POST /v1/catalog/categories` · `PUT /v1/catalog/categories/:id` · `GET …`                                                                                                                                             | `catalog:manage` / `catalog:view`                            | tenant                                       | POST → `Idempotency-Key`; `PUT /:id` → `If-Match`                                                                                                                                                                                                     |
| 3.2  | `POST/PUT/GET /v1/catalog/product-types[/:id]`                                                                                                                                                                         | `catalog:manage` / `catalog:view`                            | tenant                                       | POST → `Idempotency-Key`; `PUT` → `If-Match`                                                                                                                                                                                                          |
| 3.2  | `POST /v1/catalog/products` · `PUT /v1/catalog/products/:id` · `POST …/:id/activate` · `POST …/:id/archive` · `GET …`                                                                                                  | `catalog:manage` / `catalog:view`                            | tenant                                       | POST → `Idempotency-Key`; `PUT /:id` → `If-Match: <version>`; `activate`/`archive` (state action) → `Idempotency-Key`. `activate` gated: `fulfilment_strategy` enabled + a base-UOM company price exists for at least one company + attributes valid. |
| 3.3  | `POST/PUT/GET /v1/catalog/attribute-definitions[/:id]` + `/options`                                                                                                                                                    | `catalog:manage` / `catalog:view`                            | tenant                                       | POST → `Idempotency-Key`; `PUT` → `If-Match`                                                                                                                                                                                                          |
| 3.3  | `PUT /v1/catalog/products/:id/attributes` (replace-set)                                                                                                                                                                | `catalog:manage`                                             | tenant                                       | parent `If-Match: <product version>`                                                                                                                                                                                                                  |
| 3.4  | `POST/PUT/GET /v1/catalog/products/:id/option-groups` + `/values`                                                                                                                                                      | `variants:manage`                                            | tenant                                       | POST → `Idempotency-Key`; `PUT` → `If-Match`                                                                                                                                                                                                          |
| 3.4  | `POST /v1/catalog/products/:id/variants` · `PUT /v1/catalog/variants/:id` · `POST …/:id/{activate,archive}` · `GET`                                                                                                    | `variants:manage` / `catalog:view`                           | tenant                                       | POST → `Idempotency-Key`; `PUT /:id` → `If-Match: <version>`; `activate`/`archive` → `Idempotency-Key`                                                                                                                                                |
| 3.5  | `POST /v1/catalog/identifiers` · `DELETE …/:id` · `GET /v1/catalog/identifiers?value=…` (scan resolve)                                                                                                                 | `identifiers:manage` / `catalog:view`                        | tenant                                       | POST → `Idempotency-Key` (`catalog.identifier.create`); `DELETE` → plain (idempotent by nature). `409` on a duplicate `(code_type, value)`.                                                                                                           |
| 3.6  | `POST/PUT/DELETE/GET /v1/catalog/uoms[/:code]`                                                                                                                                                                         | `catalog:manage` / `catalog:view`                            | tenant                                       | POST → `Idempotency-Key`; `PUT` → `If-Match`. `422` if `UomRegistry` rejects the def.                                                                                                                                                                 |
| 3.6  | `PUT /v1/catalog/variants/:id/conversions` (replace-set) · `PUT /v1/catalog/variants/:id/base-uom`                                                                                                                     | `variants:manage`                                            | tenant                                       | parent `If-Match: <variant version>`. `422` on an invalid ratio / unregistered unit.                                                                                                                                                                  |
| 3.7  | `PUT /v1/catalog/companies/:companyId/variants/:variantId/prices` (replace-set of `company_variant_uom_price`) · `GET /v1/catalog/companies/:companyId/variants/:variantId/prices?branchId=&uom=` (**resolved** price) | `pricing:manage` / `catalog:view`                            | **`@ScopedParam({ company: 'companyId' })`** | replace-set → parent `If-Match: <variant version>`. `422` on a cross-currency price / not-DB-enabled currency / currency ≠ company `default_currency` (D0-2).                                                                                         |
| 3.8  | `PUT /v1/catalog/branches/:branchId/availability` (bulk flag set) · `GET /v1/catalog/branches/:branchId/catalog` (branch-effective: availability + resolved prices)                                                    | `branch_price:manage` (write) / `catalog:view` (read)        | **`@ScopedParam({ branch: 'branchId' })`**   | bulk set → parent `If-Match` per affected variant, or an idempotency key on the bulk op; branch-scoped user sees only granted branches                                                                                                                |
| 3.8  | `PUT /v1/catalog/branches/:branchId/variants/:variantId/prices` (branch override) · `DELETE …`                                                                                                                         | `branch_price:manage`                                        | `@ScopedParam({ branch: 'branchId' })`       | `PUT` → `If-Match: <variant version>`; `DELETE` → plain. The branch must belong to a company the caller is scoped to.                                                                                                                                 |
| 3.9  | `GET /v1/catalog/companies/:companyId/variants/:variantId/tax` (resolved category + current rate for the company's country/date)                                                                                       | `catalog:view`                                               | `@ScopedParam({ company: 'companyId' })`     | — — reads Task 2.7 data via `TaxResolutionService`; **no computation on an amount** (D2-8)                                                                                                                                                            |
| 3.9  | `PUT /v1/catalog/products/:id/tax-category` / `.../variants/:id/tax-category`                                                                                                                                          | `catalog:manage`                                             | tenant                                       | `If-Match: <version>`                                                                                                                                                                                                                                 |
| 3.10 | `POST /v1/platform/tenants/:tenantId/apply-business-type-template`                                                                                                                                                     | `platform:catalog_capability:manage` (platform, step-up)     | —                                            | `Idempotency-Key` (`catalog.template.apply`). Body carries explicit **replace / merge** semantics (D2-4); additive by default, never deletes/disables existing config.                                                                                |

---

## E. Permission / entitlement matrix

### E.1 Permissions (D2-6 — no rename/duplicate of an existing key)

| Key                                  | Group (metadata)                   | Phase 3a                          | Used by                                                                                                                                         |
| ------------------------------------ | ---------------------------------- | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `catalog:view`                       | `catalog`                          | **activate**                      | every catalog read                                                                                                                              |
| `catalog:manage`                     | `catalog`                          | **activate**                      | categories, product types, products, attributes, UOMs, tax-category                                                                             |
| `variants:manage`                    | `catalog`                          | **activate**                      | option groups, variants, conversions, base-UOM                                                                                                  |
| `pricing:manage`                     | `catalog`                          | **activate**                      | `company_variant_uom_price`                                                                                                                     |
| `branch_price:manage`                | `catalog`                          | **activate**                      | branch price override + branch availability                                                                                                     |
| `identifiers:manage`                 | **`inventory` (unchanged — D2-6)** | **activate**                      | `item_identifier` — the group is display metadata; the key is canonical and is not moved/duplicated                                             |
| `platform:catalog_capability:manage` | platform realm — **NEW**           | **add** (+ `STEP_UP_PERMISSIONS`) | the Super-Admin capability-config + template-apply routes. **Distinct** from `platform:entitlements:manage` so it can be granted independently. |

`promotions:manage` is **not** activated (Phase 7/10).

**`MODULE_OF_PERMISSION`:** `catalog:*` / `variants:*` / `pricing:*` /
`branch_price:*` / `identifiers:*` map to the **`catalog`** foundation module
(always entitled). A `custom_composition` capability check is done in the
**service**, not via `MODULE_OF_PERMISSION`.

### E.2 Four layers — all applied (D2-5)

| Layer                      | What it answers                                                                                                                                 | Mechanism                                                                | Enforced where                                      |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | --------------------------------------------------- |
| **Entitlement**            | does the plan include this module?                                                                                                              | `entitlement_default` / `tenant_entitlement` + `policy-engine.ts` step 5 | guard pipeline                                      |
| **Catalog Capability**     | has Super Admin enabled this capability for this tenant? (which `fulfilment_strategy`, which templates, POS/Web visibility, lot/expiry toggles) | `tenant_catalog_capability` rows (D2-5), Super-Admin write only          | the catalog **service** at write time               |
| **Permission**             | may this user do this action?                                                                                                                   | roles + grants + `permission_registry`                                   | guard pipeline                                      |
| **Business Type Template** | what defaults were suggested?                                                                                                                   | `business_type_template` + `tenant.business_type_key`                    | **apply-time only** — never a runtime branch (D0-3) |

**Effective access is constrained by every applicable layer.** A Business Type
template **never** grants a billing entitlement — enabling a template only
proposes capability rows; the entitlement axis is untouched.

---

## F. Event / realtime matrix

Publisher: the catalog service writes an `outbox` row **in the same DB
transaction** (existing `OutboxWriter`); downstream is the unchanged Task
2.4→2.5→2.6 pipeline. Envelope = the frozen ADR-0017 §3 fields — **never the
payload**. Events are tenant-isolated, branch-authorised by the gateway,
`event_id`-deduped, cursor-resumable.

| Event `type`                          | When                                                                        | `branch_id`                                                                                         | Consumer / why                             | Volume |
| ------------------------------------- | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------ | ------ |
| `catalog.company.price_changed`       | a `company_variant_uom_price` change on a variant `ACTIVE` for that company | `null` (company-wide — the gateway still filters delivery to sockets whose session company matches) | same-branch POS refreshes the item's price | low    |
| `catalog.branch.price_changed`        | a `branch_variant_uom_price` change                                         | the affected branch                                                                                 | POS at that branch refreshes               | low    |
| `catalog.branch.availability_changed` | `branch_variant_availability.available` toggled for an `ACTIVE` variant     | the branch                                                                                          | POS greys out / restores an item           | low    |
| `catalog.variant.status_changed`      | a variant → `ACTIVE` ↔ `ARCHIVED`                                           | `null` (tenant-wide)                                                                                | POS adds/removes the item                  | low    |
| `catalog.product.status_changed`      | a product → `ACTIVE` ↔ `ARCHIVED`                                           | `null`                                                                                              | POS list refresh                           | low    |

**Not published** (POS refetches on demand): `DRAFT` edits, category tree edits,
attribute-definition edits, identifier add/remove, UOM/conversion edits,
capability/template changes (a Super-Admin action — the Owner UI refetches),
tax-category assignment. The final event set is a **Task 3.10 deliverable**.
**No** new topic / channel / transport. A company-scoped `catalog.company.*`
event is delivered by the gateway only to sockets whose session `company_scope`
covers that company — **Open Decision I.3** confirms whether the gateway's
existing branch filter already covers this or needs a company-scope check added.

---

## G. Hard-gate matrix (Phase 3a — build-blocking at the task that introduces each)

| Gate                             | Assertion                                                                                                                                                                                                                                                                                                                                                                                                                      |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **HG3-MONEY**                    | Every Phase 3 money value goes through `@flower/money`; no floating point; no duplicated currency-exponent logic; the `packages/db` `Currency`-exponent parity test stays green + build-blocking; a DB currency absent from `@flower/money` or with a mismatched exponent fails the parity test.                                                                                                                               |
| **HG3-UOM**                      | Every quantity/conversion goes through `@flower/uom`; **no conversion arithmetic re-implemented** anywhere (source scan + review); a `uom` / `uom_conversion` write `UomRegistry` rejects is `422`; `COUNT` units discrete; **no `GLOBAL` cross-family conversion scope value** (schema + test) — cross-family only as product/variant-scoped rows (D0-1).                                                                     |
| **HG3-GENERIC-CATALOG**          | No `FlowerProduct`/`PerfumeProduct`/`BakeryProduct`/`GroceryProduct`-style entity, table, service, or file; no per-business-type inventory/pricing engine; `product`/`variant` have **no** vertical-specific nullable columns (vertical data is `product_attribute_value`); one `product → … → variant → company price` pipeline. Boundary lint + review.                                                                      |
| **HG3-NO-BT-BRANCH**             | No code path reads `tenant.business_type_key` / a business-type label to branch behaviour — a repo scan (`business_?type`) outside template-application code + a review check.                                                                                                                                                                                                                                                 |
| **HG3-PER-UOM-PRICE**            | A per-UOM sale price is an **independent stored value**, never `base_price × conversion_factor` (test: a Box-of-12 priced ≠ 12 × Piece resolves to the stored Box price); a base-UOM company price is required before a variant is `ACTIVE` for that company; a resolution never invents a price for an unpriced UOM.                                                                                                          |
| **HG3-COMPANY-PRICE**            | **One tenant, an AE company (AED) + a SA company (SAR) sharing the same catalog `variant`, keep independent company prices; no cross-company price/currency leakage** (a mandatory acceptance test); a `branch_variant_uom_price` override affects only its own branch/company; a price resolution never falls back to a tenant-wide or another company's currency price.                                                      |
| **HG3-CATALOG-SCOPE-SEPARATION** | Catalog definition (tenant), company commercial config (tenant+company), branch overrides (tenant+company+branch), branch stock (**absent** — D2-11) are distinct; a test proves branch availability is a boolean not a quantity and that no Phase 3a table stores a stock balance.                                                                                                                                            |
| **HG3-TEMPLATE-SNAPSHOT**        | An edit to a platform-global `business_type_template` **does not** mutate any existing tenant's `tenant_catalog_capability` rows; a tenant's capability rows record the source template `version`; a Super-Admin re-apply is an explicit audited operation with declared replace/merge semantics.                                                                                                                              |
| **HG3-CAPABILITY-NORMALIZATION** | `tenant_catalog_capability` has `UNIQUE (tenant_id, capability_key)`; writing one capability row **cannot** overwrite an unrelated capability row (a test); no single opaque JSON document holds the full capability state.                                                                                                                                                                                                    |
| **HG3-PERMISSION-STABILITY**     | No existing permission key is renamed or duplicated; `identifiers:manage` stays the one canonical key; only `platform:catalog_capability:manage` is added; the `@flower/permissions` key-registry test + the probe meta-test stay green.                                                                                                                                                                                       |
| **HG3-CAPABILITY**               | A create is rejected when its `fulfilment_strategy` / template is not enabled in `tenant_catalog_capability`; only Super Admin (platform, step-up) writes the capability config; Owner/Admin/POS cannot; a disabled capability's UI is inert (contract).                                                                                                                                                                       |
| **HG3-RLS**                      | RLS `ENABLE + FORCE` + policy on every new tenant-owned table; `business_type_template` RLS-exempt (`flower_app` SELECT-only); a no-GUC scoped query returns 0 rows on every new table; `flower_app` still `NOSUPERUSER NOBYPASSRLS`.                                                                                                                                                                                          |
| **HG3-TENANT-ISOLATION**         | The Phase 1 cross-tenant probe suite stays green + is **extended to every new Phase 3a endpoint** (act as tenant B, try tenant A's category/product/variant/price/identifier by id/param/URL → 403/404 or zero rows); still mutation-tested.                                                                                                                                                                                   |
| **HG3-BRANCH-ISOLATION**         | **The `TESTING-STRATEGY.md` branch-isolation probe suite is introduced here (Phase 3), build-blocking** — a Dubai-scoped user cannot read/write a Sharjah branch's availability or price override; a multi-branch user sees only granted branches; a POS terminal id confers no cross-branch reach. **Plus a company-isolation check** (a user scoped to company A cannot read/write company B's `company_variant_uom_price`). |
| **HG3-IDEM**                     | The D2-9 contract is applied per route; a `POST`/action replays a stored `2xx` on retry (different hash → 409); no catalog route is on a credential family.                                                                                                                                                                                                                                                                    |
| **HG3-AUDIT**                    | Every mutation in the D2-10 list writes an `audit_log` record via the existing `AuditWriter` against a **registered** `AUDITABLE_ACTIONS` key (`actions.test.ts` enforces the closed set — a new mutation cannot ship without its audit entry). No second audit system.                                                                                                                                                        |
| **HG3-REALTIME-AUTHZ**           | Catalog events publish via the existing outbox→relay→gateway path; a branch-Y socket never receives a branch-X `catalog.branch.*` event; a company-B socket never receives a company-A `catalog.company.*` event; a tenant-B socket never receives a tenant-A event; duplicate `event_id` suppressed; the realtime acceptance suite stays green.                                                                               |
| **HG3-NO-PREMATURE-DOMAIN**      | No inventory movement/balance/reservation, no BOM/recipe/composition, no order/payment/GL/receivable/settlement/cancellation table or code, no Z-report, no storefront, no POS checkout engine, no tax computation on an amount. Boundary lint + review.                                                                                                                                                                       |
| **HG3-REGRESSION**               | The full Phase 0–2-core suite (`turbo run test` — currently 34 tasks: api 171 · worker 87 · realtime 44 · scheduler 12 · db 43 · backend 17 · spike-rls 21 · money 49 · uom 42 · …) stays green after every Phase 3a task.                                                                                                                                                                                                     |
| **HG3-CI**                       | GitHub CI `verify` + `security` + `e2e` + `realtime` green on every Phase 3a PR; `security-review` (cumulative from `phase-2-core-complete` → the task HEAD) has no open Critical/High.                                                                                                                                                                                                                                        |

---

## H. Later-phase / non-scope matrix

### H.1 Explicitly OUT of Phase 3a

| Item                                                                                     | Phase         | Foundation-only hook in 3a?                                                                                                                                                     |
| ---------------------------------------------------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Inventory movement ledger, `branch_inventory_balance`, adjustment, `inventory_item`      | **5**         | **No table** (D2-11). `item_identifier.target_kind` reserves `INVENTORY_ITEM`; `variant.base_uom_code` is the normalisation anchor.                                             |
| Batch / lot / expiry / FEFO                                                              | 5             | **Stored not enforced:** `tenant_catalog_capability` carries `lot_batch` / `expiry` toggles (generalises Z-11); no `lot` table, no enforcement.                                 |
| Purchase receiving, `goods_receipt`, supplier bills / documents                          | 5             | `company_variant_uom_price.purchase_*` nullable columns → Phase 5 needs no schema change for UOM-specific cost.                                                                 |
| **Product media**                                                                        | 5 (`files`)   | **No hook** — D2-7. Catalog definitions have no media in 3a; media arrives with explicit file references + ownership/ordering/lifecycle.                                        |
| BOM / recipe / bouquet / hamper composition                                              | 6             | `product.fulfilment_strategy` models `BOM` / `CUSTOM`; such a product may exist in 3a with no recipe (unsellable until Phase 6). `custom_composition` entitlement module added. |
| Production / work orders / wastage / spoilage                                            | 6             | none                                                                                                                                                                            |
| **Orders, order lines, walk-in sale, gapless numbering**                                 | **3b**        | The catalog **price/tax resolution services** (3.7 / 3.9) are the read APIs a 3b order line will call to build a self-contained **snapshot** (§H.2.1). No `order` table in 3a.  |
| **Payments, provider adapter, webhooks**                                                 | 3b            | `provider_credential` (Phase 1 vault shell) already exists; no payment table.                                                                                                   |
| **Accounting / GL / posting engine / CoA / periods**                                     | 3b            | none — §H.2 for the constraints 3a must respect.                                                                                                                                |
| **Receivables / credit / advances / gift cards**                                         | 3b            | none                                                                                                                                                                            |
| **Settlement / allocation / settlement discount**                                        | 3b            | §H.2                                                                                                                                                                            |
| **Cancellation / refund / cancellation charge / account credit**                         | 3b            | §H.2                                                                                                                                                                            |
| **Customer financial subledger**                                                         | 3b            | none                                                                                                                                                                            |
| Z-Report, cash register, POS shift, X-Report, expenses                                   | 4             | none                                                                                                                                                                            |
| Customer Web storefront, online-order queue, delivery                                    | 7             | `customer_web_visible` capability flag exists so Phase 7's published-catalog projection has a source of truth; no storefront code.                                              |
| Promotions / coupons / loyalty / subscriptions                                           | 7 / 10        | `promotions:manage` stays inert; no table.                                                                                                                                      |
| Cart/line/order **tax computation**, inclusive/exclusive, rounding policy, tax snapshots | **3b** (D2-8) | 3a ships tax **category** + rate **resolution** only.                                                                                                                           |

### H.2 ADR-0019 structural constraints Phase 3a must not violate

1. **"Invoice" vs `order` is undecided** (Phase 3b modelling). Phase 3a puts
   nothing invoice/receivable-shaped on a catalog table. The catalog
   price/tax resolution services (3.7 / 3.9) return a **self-contained,
   snapshottable** result — `{ variant_id, uom_code, company_id, resolved sell
Money, tax_category_key, rate_bps, effective_from, resolution_source }` — so a
   3b order line snapshots it and never re-resolves.
2. **`payment` ≠ `payment_allocation`** (ADR-0019 §8) — a 3b concern; 3a
   introduces nothing that presumes "payment = applied".
3. **`settlement` is a header with no value column** (§9) — no settlement concept
   in 3a.
4. **Account credit = `ADVANCE` with a `source_kind` reference** (§31) — no
   parallel balance; 3a introduces no customer balance.
5. **Six independent lifecycle states** (order / invoice-payment / payment /
   receivable / refund / inventory-disposition) — Phase 3a's `product`/`variant`
   `status` (`DRAFT`/`ACTIVE`/`ARCHIVED`) is a **seventh, unrelated** axis and is
   never conflated with any of the six.
6. **Append-only subledger; projections derived** — 3a stores **no** derived
   money balance; a price is a configuration value, not a running balance.
7. **Contra-revenue discount separation** (ZF-7 / §13 / §26) — 3a models **no**
   discount; `product`/`variant`/price tables carry no discount column.

### H.3 Phase 3b task outline (NOT scheduled here — a later plan)

Context only; each is its own STOP-and-approve task, ADR-0019's detail designed
in that later plan: **3b.1** CoA + posting engine skeleton · **3b.2** CRM core
(`customer` + **derived** credit fields) · **3b.3** Orders (`order`, `order_line`
with price/tax/discount **snapshot**, walk-in state machine, gapless numbering
inside the txn) · **3b.4** tax computation + rounding policy · **3b.5** Payments
(`PaymentProvider` port + 1 adapter, `payment` + `payment_allocation` **separate**
rows, webhook idempotent on the provider event id) · **3b.6** Receivables
(`invoice_payment_status` derivation, `ar_transaction`/`advance_transaction`
subledger + reconciliation job) · **3b.7** Settlement (header only, AUTO-FIFO via
`Money.capAllocate`, manual + discount toggles) · **3b.8** Cancellation / refund /
cancellation-charge policy engine · **3b.9** the **atomic walk-in sale** (order +
payment + allocation + **synchronous journal posting** + audit, one txn + one
outbox event; realtime `order.*` / `payment.updated`) · **3b.10** first reporting
rollups · **3b.11** verification + **`phase-3-complete`** (only after the full
roadmap exit criteria — D2-1).

---

## I. Open owner decisions (remaining after the 2026-09-06 amendment)

Most prior open items (I.1, I.4–I.11 in the earlier draft) are now **locked** by
§0.2 (D2-1 split · D2-3 two price tables · D2-5 normalized capability · D2-6
permission stability · D2-7 media deferred · D2-8 tax scope · D2-9 idempotency
contract · D2-10 audit scope · D2-11 no inventory shell · D2-12 migration
wording · Appendix A presets). What remains:

| #       | Decision                                                                                                                                                                                                                       | Recommendation                                                                                                                                                                                                                           |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **I.1** | **`business_type_template.template_payload` + `tenant_catalog_capability` closed key list + config JSON schemas.** The exact structured shapes.                                                                                | A **Task 3.1 deliverable** — proposed for owner sign-off before the seed/migration lands.                                                                                                                                                |
| **I.2** | **Per-branch price uniqueness when a UOM has no company row.** Can a branch override a UOM that has no `company_variant_uom_price`?                                                                                            | **No** — a branch override requires a company price for that `(variant, uom)` to exist (the override overrides _something_). Enforced by the service.                                                                                    |
| **I.3** | **Company-scoped realtime delivery.** Does the Task 2.6 gateway's existing per-branch authorization already restrict a `catalog.company.*` event to the right company's sockets, or does it need an added company-scope check? | Investigate in Task 3.10; if the gateway currently only filters by tenant + branch, add a company-scope predicate to `isAuthorized` for `catalog.company.*` (a small, contained change to the existing gateway, not a new architecture). |
| **I.4** | **`product_type` — tenant data or platform reference?** ADR-0018's "recommended variant/attribute templates" suggest a reference concept.                                                                                      | **Tenant data**, seeded from a template (like `category`). Keeps it editable and tenant-isolated; no platform-global product-type table.                                                                                                 |
| **I.5** | **`identifiers:manage` group metadata.** Leave in `inventory`, or (compatibly, without renaming the key) surface it under a `catalog` grouping for the Owner UI?                                                               | Leave the **key** exactly as-is (D2-6). If the Owner UI wants it under "Catalog", that is a **frontend grouping** concern, not a `@flower/permissions` change.                                                                           |
| **I.6** | **Multi-company `activate`.** Must a variant have a base-UOM price for **every** company, or **at least one**, before it can be `ACTIVE`?                                                                                      | **At least one** company — a variant is "ACTIVE (sellable)" per company, driven by whether that company has priced it; a global `variant.status = ACTIVE` means "the definition is finished", not "every company sells it".              |

---

## J. Proposed first implementation task (after this plan is approved)

> **Task 3.1 — Catalog capability & Business-Type template foundation.**

| Field                           | Detail                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Goal**                        | Super Admin can, per tenant, configure which catalog capabilities/templates that tenant may use; the Owner can read its own enabled capabilities; the concrete Business-Type preset payloads (Appendix A list is fixed) + the closed `capability_key` list + config JSON schemas are agreed (I.1). **No product data, no catalog CRUD.**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| **Scope**                       | `business_type_template` (platform-global reference + `version` column + curated structured seed — Appendix A) · `tenant_catalog_capability` (**normalized**, unique `(tenant_id, capability_key)`, source-template + version + applied-at/by metadata — D2-4/D2-5) · additive nullable `tenant.business_type_key` + `business_type_applied_version` + `business_type_applied_at` (D2-12) · new entitlement module `custom_composition` (+ mark `catalog` always-on) · `platform:catalog_capability:manage` (NEW, platform realm, + `STEP_UP_PERMISSIONS`) · the 3 APIs (§D task 3.1) · the capability-check helper the later catalog tasks call · provisioning gains one **additive, non-destructive** template-apply step (snapshot defaults into `tenant_catalog_capability`; re-apply is explicit + audited).                                                                                                                                                                               |
| **Models / tables**             | `business_type_template` · `tenant_catalog_capability` · `tenant.*` additive columns                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **APIs**                        | §D task 3.1 rows                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **Permissions**                 | `platform:catalog_capability:manage` (NEW, step-up) · `catalog:view` (activate — Owner read)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **Entitlements / capabilities** | add `custom_composition`; `catalog` is a foundation module; the four-layer distinction (D2-5) is documented + tested                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **RLS / isolation**             | `tenant_catalog_capability` — `ENABLE + FORCE` + tenant policy; `business_type_template` — RLS-exempt, `flower_app` SELECT-only; a no-GUC read of `tenant_catalog_capability` returns 0 rows                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **Concurrency / idempotency**   | `PUT …/catalog-capability` → `Idempotency-Key` (`catalog.capability.set`) — it carries a template-snapshot side effect (D2-9)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **Audit**                       | `tenant.catalog_capability_changed` (NEW `AUDITABLE_ACTIONS` key, `security: true`) + `catalog.template_applied` — via `AuditWriter`, in the write txn (D2-10)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **Outbox / realtime**           | none — a Super-Admin config change; the Owner UI refetches                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **Tests**                       | unit: the capability-check helper truth table; the four-layer distinction (entitlement vs capability vs permission vs template — a template application does **not** touch `tenant_entitlement`). Integration (Testcontainers): Super-Admin write persists + is audited; a tenant user → 403 on the write route; a no-GUC read returns nothing; RLS `ENABLE + FORCE` asserted; `business_type_template` readable by `flower_app` with no GUC, not writable; **HG3-CAPABILITY-NORMALIZATION** (writing one capability doesn't touch another; `UNIQUE (tenant_id, capability_key)`); **HG3-TEMPLATE-SNAPSHOT** (editing a global template does not mutate an already-applied tenant's rows; the version is recorded); provisioning applies the template additively (re-apply never deletes); the schema-baseline + `TENANT_SCOPED_TABLES`/`PLATFORM_GLOBAL_TABLES` + RLS-coverage tests updated; the cross-tenant probe suite extended to the new endpoints; full Phase 0–2-core regression green |
| **Hard gate**                   | HG3-CAPABILITY (partial) · HG3-CAPABILITY-NORMALIZATION · HG3-TEMPLATE-SNAPSHOT · HG3-PERMISSION-STABILITY · HG3-RLS · HG3-TENANT-ISOLATION · HG3-NO-BT-BRANCH · HG3-IDEM · HG3-AUDIT · HG3-REGRESSION · HG3-CI                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **Explicit non-scope**          | no `category`/`product`/`variant`/`attribute`/`uom`/`price`/`identifier`/`tax` table or API; no catalog CRUD; no realtime; no Phase 3b anything; the capability **enforcement** on a product create lands in Task 3.2                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **Depends on**                  | Task 3.0 (done)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

---

## K. Documentation corrections this plan records (applied in Task 3.1)

1. **`DB-CONVENTIONS.md` / `DOMAIN-MODEL.md` "Partitioning (from migration #1)"**
   — amend to "declared here; each table is created and partitioned by its
   owning phase" (Phase 1's migration #1 created none of `order` / `journal_*`;
   `idempotency_key` was de-partitioned in Task 2.1).
2. **`@flower/permissions`** — activate the Phase-3a catalog subset (`catalog:*`,
   `variants:manage`, `pricing:manage`, `branch_price:manage`,
   `identifiers:manage`); **add** `platform:catalog_capability:manage`
   (+ `STEP_UP_PERMISSIONS`). **`identifiers:manage` is not renamed, moved, or
   duplicated** (D2-6).
3. **`@flower/shared-types` `ENTITLEMENT_MODULES`** — add `custom_composition`;
   note `catalog` is a foundation module (always on).
4. **`ROADMAP.md` §Phase 3** — a note that Phase 3 executes as **3a (catalog)**
   then **3b (revenue path + financial truth)** with a
   `phase-3a-catalog-complete` **checkpoint** (never full-Phase-3) between
   (D2-1); dependency order and exit criteria unchanged; `phase-3-complete` only
   after the full Phase 3b roadmap exit criteria.
5. **`DB-CONVENTIONS.md` §Migrations** — a note that an **additive nullable
   column** on a shipped table is permitted (D2-12), distinct from a destructive
   rewrite (which is not).
6. **`API-CONVENTIONS.md`** — already corrected in Task 3.0 (money = string
   `amountMinor`; quantity wire shape); no further change.

---

## Appendix A — initial curated Business-Type preset set (D0-3)

**Default presets only. Never a runtime discriminator; never a per-vertical
entity/code path (D0-3, HG3-NO-BT-BRANCH).** Excluded: Jewellery/Accessories,
Mobile/Mobile-Accessories.

`FLOWER_FLORIST` · `GIFT_HAMPER` · `BAKERY_CAKE` · `CHOCOLATE_CONFECTIONERY` ·
`PERFUME_ATTAR` · `CANDLE_HOME_FRAGRANCE` · `COSMETICS_BEAUTY` ·
`HANDMADE_PRODUCTS` · `DATES_DRY_FRUITS_NUTS` · `COFFEE_TEA` ·
`SPICES_FOOD_PACKING` · `PLANT_NURSERY` · `BALLOON_PARTY_EVENT` ·
`PERSONALIZED_GIFTS` · `CORPORATE_GIFTING` ·
`GROCERY_MINIMART` · `SUPERMARKET` · `WHOLESALE_DISTRIBUTION` ·
`GENERAL_TRADING` ·
`STATIONERY_BOOKS` · `TOYS_BABY` · `PET_STORE` ·
`CLOTHING_BOUTIQUE` · `FOOTWEAR` ·
`COMPUTER_ELECTRONICS` ·
`HARDWARE_TOOLS` · `ELECTRICAL_PLUMBING` · `BUILDING_MATERIALS` ·
`AUTO_PARTS` ·
`HOME_DECOR` · `KITCHENWARE` · `PACKAGING_DISPOSABLES` · `CLEANING_SUPPLIES` ·
`MULTI_CATEGORY_RETAIL` · `CUSTOM`

Each template's concrete `template_payload` (suggested categories, attribute
templates, variant templates, UOM templates, recommended capability preset) is a
**Task 3.1 deliverable** for owner sign-off (I.1).

---

_End of PHASE-3-PLAN.md. Awaiting owner approval of the plan and of Task 3.1.
No Prisma migration, no Product/Category/Pricing runtime code, and no Task 3.1
work has been started._
