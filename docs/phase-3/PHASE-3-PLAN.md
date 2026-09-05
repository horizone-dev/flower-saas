# PHASE-3-PLAN.md — Phase 3 implementation plan (catalog foundation)

> **Status:** DRAFT — for owner approval. Planning only. No runtime/domain code,
> no `schema.prisma` change, no migration is produced by this document.
>
> **Approved `main` at authoring:** `83ef2e18e3f47d18282008aaee8118990a32228a`
> (Task 3.0 — money/UOM completion pass, merged). Phase 0, Phase 1, Phase 2-core
> complete (`phase-0-complete` `c1ca217` · `phase-1-complete` `d44566b` ·
> `phase-2-core-complete` `a459858`).
>
> **Governing docs reconciled:** `ROADMAP.md` §Phase 3 · `ADR-0018` · `ADR-0019` ·
> `PHASE-2-BACKLOG.md` · `API-CONVENTIONS.md` · `DB-CONVENTIONS.md` ·
> `TESTING-STRATEGY.md` · `ARCHITECTURE.md` §15·17·18·19 / §48 / §48a / §F ·
> `DOMAIN-MODEL.md` · `packages/money` · `packages/uom` · the current 47-model
> Prisma schema · `@flower/permissions` · the guard/entitlement pipeline.

---

## 0. Locked decisions (carried from Task 3.0 — preserve exactly)

**D0-1 — UOM cross-family conversion.** Generic/global conversion stays
family-safe (`LENGTH`/`MASS`/`VOLUME`/`COUNT` resolve via each unit's ratio to
the family base; `EACH` units have no generic conversion). Cross-family
conversions such as `roll → meter` or `bag → kg` are allowed **only** as
**explicit item- or variant-specific** `uom_conversion` rows. **No unrestricted
global cross-family conversion rule is ever created.**

**D0-2 — Currency membership.** `@flower/money` remains a pure arithmetic
currency superset (GCC currencies + `USD` + `EUR` + any explicitly approved
arithmetic currency). The **DB `Currency` reference / configuration** determines
which currencies are actually **enabled / usable** by a company or a
transaction. Existence in `@flower/money` does **not** mean tenant/business
enabled. Any currency the platform actually uses **must** keep exponent parity
with `@flower/money` — the `packages/db` parity test (`gcc-reference-data.test.ts`)
stays build-blocking.

**D0-3 — Business Type presets.** Business Type is a preset/template only, applied
**once** (at provisioning or an explicit Super-Admin re-application). It is
**never a runtime discriminator** — no code branches on
`tenant.business_type_key` (`if flower … / if perfume … / if bakery …` is
forbidden; a probe/lint check enforces this — HG3-NO-BT-BRANCH). Current approved
preset direction **excludes** Jewellery/Accessories and Mobile/Mobile-Accessories;
other approved shared-module presets remain eligible. The exact preset list + seed
payloads are a **Task 3.1** deliverable, not fixed here.

---

## A. Phase 3 architecture summary

### A.1 What `ROADMAP.md` §Phase 3 fixes

Phase 3 is _"Catalog, tax, orders, POS walk-in sale, payments, double-entry GL,
receivables — first revenue path + financial truth"_. Roadmap-fixed modules:
`catalog · identifiers · pricing(basic) · tax · orders · payments · accounting
(CoA + posting engine + periods) · receivables (AR / credit / advances / gift
cards) · crm(core) · files · reporting(first rollups)`. Roadmap exit criteria:
a full cash/card/credit/advance walk-in sale posts correct balanced GL entries;
trial balance ties; Owner figures reconcile to the GL. ADR-0018 (catalog
capability + `variant_uom_price`) and ADR-0019 Part A + B (invoice payment
status, settlement, cancellation, refund) are **additive Phase 3 scope** per the
roadmap's own dated notes.

### A.2 Scope of _this_ plan — Phase 3a (catalog foundation)

This plan details **Phase 3a only**: money/UOM (Task 3.0, done) → catalog
capability & template configuration → the one generic catalog core (categories,
product types/behaviours, typed attributes, variants, identifiers) → UOM
configuration + item/variant conversions → per-UOM sale pricing + a
purchase/cost-path foundation → branch catalog availability + branch price
overlay → catalog realtime. It ends with a verification pass and a
`phase-3a-catalog-complete` checkpoint tag.

**Phase 3b** — orders, tax computation on a sale, payments + one provider
adapter, the double-entry GL + posting engine, receivables/credit/advances,
customer settlement + allocation + settlement discount, cancellation + refund +
cancellation charge, the atomic walk-in sale, first reporting rollups — is a
**separate plan** written after `phase-3a-catalog-complete` is tagged. This plan
gives Phase 3b a **high-level task outline (§H.3)** and the **ADR-0019 structural
constraints (§H.2)** that Phase 3a must not paint into a corner, but **no**
Phase 3b task is detailed, scheduled, or implemented here.

> **Open Owner Decision I.1** confirms this 3a/3b split (vs. one long Phase 3
> task sequence). The rest of this plan assumes the split.

### A.3 One generic catalog core (ADR-0018, binding)

A **single** `product → category → product_type/behaviour → typed attributes →
variant → identifier (SKU/BARCODE/QR) → per-UOM pricing → base UOM → conversion
UOMs → branch availability/price` pipeline serves **every** business type. In one
tenant's catalog a flower shop sells flowers, bouquets, chocolates, perfumes,
toys, balloons, cakes, plants, gift boxes, hampers and general retail products —
through the same catalog, the same cart/invoice model (Phase 3b), and (Phase 5)
the same inventory engine.

- **No** `FlowerProduct` / `PerfumeProduct` / `BakeryProduct` entity, table,
  service, or code path. **No** per-business-type inventory engine.
- Product behaviour is driven **only** by `fulfilment_strategy`
  (`STOCKED · BOM · CUSTOM`), enabled capabilities, and configured data.
- Vertical variation (perfume volume, stem count, shelf-life) is a **typed
  attribute value**, never a nullable column on `product`/`variant`
  (`ARCHITECTURE.md` §15 "never hardcoded columns"; ADR-0018 §6).
- **Mixed-cart** is a binding acceptance requirement (Phase 3b tests) — no code
  path may assume a single category / business type. Phase 3a's contribution:
  the catalog model is category- and business-type-neutral by construction.

### A.4 Four **distinct** catalog concepts — never conflated

| Concept                 | What it is                                                                                                               | Scope                                                                         | Phase               |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- | ------------------- |
| **Catalog definition**  | the product / category / attribute / variant / identifier / base-UOM / conversion definition — the _what exists to sell_ | **tenant** (company-neutral: one catalog per tenant, usable by every company) | 3a                  |
| **Branch availability** | is this variant offered for sale at this branch right now — a boolean/flag, **not** a quantity                           | tenant + **branch**                                                           | 3a                  |
| **Branch price**        | an optional per-branch override of a variant's per-UOM sale price                                                        | tenant + **branch**                                                           | 3a                  |
| **Branch stock**        | on-hand / reserved / available **quantity** of the item at the branch                                                    | tenant + **branch**                                                           | **5** — NOT Phase 3 |

**Branch stock is never catalog truth.** A variant is "available" at a branch
because `branch_variant_availability.available = true` (a merchandising decision),
**not** because stock exists. Phase 5 layers real availability
(`AvailabilityService` over `branch_inventory_balance` + reservations) on top —
the Phase 3a availability flag becomes the "is it merchandised here" gate that
Phase 5's quantity check runs _inside_.

### A.5 Money / UOM — Task 3.0 packages are authoritative

Every Phase 3 model and API **reuses** `@flower/money` and `@flower/uom`. No
floating point for money. **No duplicate currency-exponent logic** and **no
duplicate UOM conversion arithmetic** is written in any API/domain module — the
domain calls `Money` / `Quantity` / `UomRegistry`. Column ↔ value-object mapping:
§C.7.

### A.6 Capabilities & Super Admin (ADR-0018 §2 / §7, binding)

Super Admin controls, **per tenant**, which catalog capabilities / modules /
templates are available (the **entitlement axis** — same axis as `ARCHITECTURE.md`
§48's feature modules, not a new axis). Owner / Admin / Manager then create and
manage the actual business data **within** what is available, gated by the
existing four axes (entitlement → permission → company scope → branch scope). A
Flower Shop tenant may have any combination of capabilities enabled (gifts,
chocolates, perfume, cakes, balloons, plants…). Owner/Admin/POS **never** gain
write access to the capability-configuration surface itself.

### A.7 Realtime / outbox — reuse the Phase 2-core pipeline

Catalog changes that must reach same-branch POS clients live use the **existing**
`DB transaction → outbox row (same txn) → Task 2.4 dispatcher → rt:stream:{tenant}
→ Task 2.5 relay → rt:live:{tenant} Pub/Sub → Task 2.6 gateway → authorized
branch sockets` path. **No second realtime architecture.** Events stay
tenant-isolated, branch-authorized, `event_id`-deduped, and resumable via the
existing cursor protocol (ADR-0017). Only genuinely useful, low-volume events
are published (§F).

### A.8 Localization / fiscal — reuse Task 2.7

Phase 3 reuses Task 2.7's `company.country_code`-driven fiscal foundation, the
`Country` / `Currency` / `CountryTaxConfig` / `TaxCategory` / `TaxRate` reference
tables, and `LocalizationService`. **No** currency-exponent, country fiscal
profile, or VAT-regime table is duplicated. Phase 3a adds a **`tax_category`
reference on the catalog** (which VAT category a product/variant falls in) and a
**tax-rate _resolution_ service** (given category + `company.country_code` + date
→ the applicable `TaxRate`). The **tax _computation_ on a sale** (line vs
invoice, inclusive vs exclusive, rounding policy, credit-note reversal) is
**Phase 3b** with orders — see **Open Owner Decision I.6**.

---

## B. Exact proposed Task 3.x sequence (Phase 3a)

Each task: its own `phase-3/3.x-<slug>` branch, one verified commit, `main`
always green, PR with the full CI gate (`verify` + `security` + `e2e` +
`realtime`), **STOP and report before the next task**, proceed only on a fresh
owner instruction. Each task that adds schema ships **one additive forward-only
expand migration** (no change to any Phase 0/1/2 table), extends
`TENANT_SCOPED_TABLES` / `PLATFORM_GLOBAL_TABLES` in `packages/db` and the
schema-baseline Testcontainers test, and adds RLS `ENABLE + FORCE` + policy on
every new tenant-owned table.

| Task     | Title                                                                                | New schema (summary)                                                                                                                       | Depends on    |
| -------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------- |
| **3.0**  | Money / UOM completion pass                                                          | _(none — packages only)_ — **DONE** `83ef2e1`                                                                                              | —             |
| **3.1**  | Catalog capability & Business-Type template foundation                               | `business_type_template` (platform-global) · `tenant_catalog_capability` · `tenant.business_type_key` (nullable FK, additive to `tenant`)  | 3.0           |
| **3.2**  | Generic catalog core — categories, product types, products                           | `category` · `product_type` · `product`                                                                                                    | 3.1           |
| **3.3**  | Typed attribute templates + values                                                   | `attribute_definition` · `attribute_option` · `product_attribute_value`                                                                    | 3.2           |
| **3.4**  | Variants + option groups                                                             | `option_group` · `option_value` · `variant` · `variant_option_value`                                                                       | 3.3           |
| **3.5**  | Identifiers — SKU / barcode / QR                                                     | `item_identifier`                                                                                                                          | 3.4           |
| **3.6**  | UOM configuration + item/variant conversions                                         | `uom` · `uom_conversion` · `variant.base_uom_code` (additive to `variant`)                                                                 | 3.4           |
| **3.7**  | Per-UOM sale pricing + purchase/cost-path foundation                                 | `variant_uom_price` (`sell_*` populated, `purchase_*` nullable/foundation-only)                                                            | 3.6           |
| **3.8**  | Branch catalog availability + branch price overlay                                   | `branch_variant_availability` · `branch_variant_price`                                                                                     | 3.7           |
| **3.9**  | Tax category on the catalog + rate-resolution service                                | `product.tax_category_key` / `variant.tax_category_key` (additive) · `TaxResolutionService` (no new table — reads Task 2.7 reference data) | 3.2, Task 2.7 |
| **3.10** | Business-type template application + catalog realtime                                | _(no new table)_ — template-apply transaction + `catalog.*` outbox events                                                                  | 3.1–3.9       |
| **3.11** | Phase 3a verification pass + `PHASE-3A-RESULTS.md` + `phase-3a-catalog-complete` tag | _(none)_                                                                                                                                   | 3.1–3.10      |

Rationale for the order: capability gating exists **before** any catalog
create-endpoint ships (3.1 first); the pipeline is built bottom-up
(category → product → attributes → variant → identifier → UOM → price →
branch overlay); tax is a thin catalog annotation + a read service late (3.9);
realtime + template application (both cross-cutting, small) land together (3.10);
verification last (3.11). Tasks 3.5 and 3.6 both depend on 3.4 and may run in
either order or be interleaved by the owner.

---

## C. Schema / RLS matrix (proposed — no migration written)

**Conventions applied to every row below** (DB-CONVENTIONS): `id uuid` default
`uuidv7()`; `created_at` / `updated_at timestamptz` UTC; extensible
kind/status/behaviour columns are `text` + a `CHECK` against a documented
allow-list, **never** a PG `enum`; composite indexes lead with `tenant_id` then
`company_id`/`branch_id` then the query key; every FK is indexed; money =
`amount_minor bigint` + `currency_code text` + `currency_exponent smallint`;
quantity = `numeric(18,4)`. **Soft-delete:** catalog definition rows use a
`status` lifecycle (`DRAFT · ACTIVE · ARCHIVED`) — **no hard delete** of an
`ACTIVE`/`ARCHIVED` row (it may be referenced by a Phase 3b order line snapshot,
a Phase 5 movement, a Phase 6 recipe); a `DRAFT` row may be hard-deleted (gated +
audited). Branch overlay rows (`branch_variant_*`) may be hard-deleted (they are
pure overrides, no history value) — deletion is audited.

### C.1 Platform-global reference (RLS-exempt)

| Table                    | Scope               | RLS                                                                                                  | Unique                                                                                                                                                            | Indexes | Notes                                                                                                                                                                                                                            |
| ------------------------ | ------------------- | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `business_type_template` | **platform-global** | **exempt** — `flower_app` SELECT-only, writes via the platform/seed path (like `country`/`currency`) | `key` (PK, e.g. `FLOWER_SHOP`, `PERFUME_SHOP`, `BAKERY`, `GIFT_HAMPER_SHOP`, `CHOCOLATE_SHOP`, `BALLOON_PARTY_SHOP`, `PLANT_NURSERY`, `GENERAL_RETAIL`, `CUSTOM`) | —       | `name_en`/`name_ar`; `template_payload jsonb` = suggested categories, attribute templates, variant templates, UOM templates, recommended capability preset. **Curated seed data.** Preset list excludes Jewellery/Mobile (D0-3). |

### C.2 Task 3.1 — capability configuration (tenant-scoped)

| Table                       |                           tenant                            | company | branch | RLS                                            | Unique                                                                                                                            | Indexes       | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --------------------------- | :---------------------------------------------------------: | :-----: | :----: | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tenant_catalog_capability` |                             ✅                              |    —    |   —    | **ENABLE + FORCE**                             | `(tenant_id)` (one config row/tenant) — or `(tenant_id, capability_key)` if modelled per-capability; **Task 3.1 picks one shape** | `(tenant_id)` | Super-Admin **write** only (platform realm — no tenant permission key reaches it, mirroring `provider_credential`); Owner/catalog **read**. Holds: enabled `fulfilment_strategy` set (`STOCKED` always on; `BOM`, `CUSTOM` toggleable), enabled default categories/attribute-templates/variant-templates/UOM-templates (seeded from the template, then Owner-editable within permission), inventory-behaviour toggles (`lot_batch`, `expiry` — generalise Z-11, **stored not enforced** until Phase 5), BOM/recipe capability, custom-composition/bundle capability, independent `pos_visible` / `customer_web_visible` flags per capability. |
| `tenant.business_type_key`  | _(additive nullable column on the existing `tenant` table)_ |         |        | _(inherits `tenant` RLS: policy keys on `id`)_ | FK → `business_type_template.key` (`ON DELETE RESTRICT`)                                                                          | —             | Set once at provisioning or by an explicit Super-Admin re-apply; **never read at runtime to branch behaviour** (D0-3). Additive column only — no retype of any `tenant` column.                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

**Entitlement-module additions** (`@flower/shared-types` `ENTITLEMENT_MODULES`,
`entitlement_default`, `tenant_entitlement`): `custom_composition` (new §48-style
module, alongside the existing `production_bom`); `catalog` is **always on** (a
foundation module, not toggleable). Coarse module entitlement is enforced by the
existing guard pipeline (policy-engine step 5); the **fine capability** (e.g.
"CUSTOM strategy enabled") is enforced by the catalog **service** at write time
(ADR-0018 §2 — "data, evaluated through the existing entitlement check").

### C.3 Task 3.2 — catalog core (tenant-scoped)

| Table          | tenant | company | branch | RLS            | Unique                         | Indexes                                                                       | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| -------------- | :----: | :-----: | :----: | -------------- | ------------------------------ | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `category`     |   ✅   |    —    |   —    | ENABLE + FORCE | `(tenant_id, parent_id, slug)` | `(tenant_id, parent_id)`                                                      | self-ref `parent_id` (nullable = root); `name_en`/`name_ar`; `sort_order`; `status` (`ACTIVE`/`ARCHIVED`). Company-neutral.                                                                                                                                                                                                                                                                                                                                                                                    |
| `product_type` |   ✅   |    —    |   —    | ENABLE + FORCE | `(tenant_id, key)`             | `(tenant_id)`                                                                 | a behaviour/attribute bundle (e.g. `PERFUME`, `CUT_FLOWER`, `CAKE`, `GENERAL`); scopes which attribute definitions apply. Seed-then-edit from a template. **Descriptive metadata only** — behaviour is `fulfilment_strategy`, never `product_type`.                                                                                                                                                                                                                                                            |
| `product`      |   ✅   |    —    |   —    | ENABLE + FORCE | `(tenant_id, slug)`            | `(tenant_id, category_id)`, `(tenant_id, status)`, `pg_trgm` GIN on `name_en` | `category_id` FK; `product_type_id` FK (nullable); `fulfilment_strategy text CHECK (∈ STOCKED,BOM,CUSTOM)` (a create is rejected by the service if the strategy is not enabled in `tenant_catalog_capability`); `name_en`/`name_ar`, `description`, `media jsonb` (image refs — real `documents` integration is later; a minimal URL list is acceptable, **Open Owner Decision I.4**); `hide_price` default false; `status` (`DRAFT`/`ACTIVE`/`ARCHIVED`); `version int` (optimistic concurrency, `If-Match`). |

### C.4 Task 3.3 — typed attributes (tenant-scoped)

| Table                     | tenant | RLS            | Unique                                             | Indexes                                | Notes                                                                                                                                                                                                                                                                                                                                      |
| ------------------------- | :----: | -------------- | -------------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `attribute_definition`    |   ✅   | ENABLE + FORCE | `(tenant_id, key)`                                 | `(tenant_id)`                          | `value_type text CHECK (∈ TEXT, NUMBER, ENUM, BOOLEAN, DATE)` — a **closed** value-type set (ADR-0018 risk 3, no arbitrary JSON); `applies_to` (nullable `category_id` / `product_type_id` scoping); `unit_hint` (e.g. "ml", nullable); `is_variant_option boolean` (does this attribute generate variants — see 3.4); `required boolean`. |
| `attribute_option`        |   ✅   | ENABLE + FORCE | `(tenant_id, attribute_definition_id, value)`      | `(tenant_id, attribute_definition_id)` | only for `value_type = ENUM`; `label_en`/`label_ar`, `sort_order`.                                                                                                                                                                                                                                                                         |
| `product_attribute_value` |   ✅   | ENABLE + FORCE | `(tenant_id, product_id, attribute_definition_id)` | `(tenant_id, product_id)`              | typed columns: `value_text`, `value_number numeric`, `value_bool boolean`, `value_date date`, `option_id` (FK → `attribute_option`) — exactly one populated per `value_type`, enforced by a `CHECK`.                                                                                                                                       |

### C.5 Task 3.4 — variants (tenant-scoped)

| Table                  | tenant | RLS            | Unique                                     | Indexes                                          | Notes                                                                                                                                                                                                                                                                                                                                                                                          |
| ---------------------- | :----: | -------------- | ------------------------------------------ | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `option_group`         |   ✅   | ENABLE + FORCE | `(tenant_id, product_id, key)`             | `(tenant_id, product_id)`                        | e.g. `SIZE`, `COLOUR`, `STYLE`, `OCCASION`; `name_en`/`name_ar`, `sort_order`.                                                                                                                                                                                                                                                                                                                 |
| `option_value`         |   ✅   | ENABLE + FORCE | `(tenant_id, option_group_id, value)`      | `(tenant_id, option_group_id)`                   | `label_en`/`label_ar`, `sort_order`.                                                                                                                                                                                                                                                                                                                                                           |
| `variant`              |   ✅   | ENABLE + FORCE | `(tenant_id, sku)` where `sku` not null    | `(tenant_id, product_id)`, `(tenant_id, status)` | `product_id` FK; generated `sku` (nullable — the numbering service / a manual value); `name_en` (denormalised for display); `base_uom_code` (added in **Task 3.6**, nullable until then, then `NOT NULL` via a follow-up expand step); `status` (`DRAFT`/`ACTIVE`/`ARCHIVED`); `version int`. A `CUSTOM`-strategy product may have **zero** variants (composition captured at sale — Phase 6). |
| `variant_option_value` |   ✅   | ENABLE + FORCE | `(tenant_id, variant_id, option_group_id)` | `(tenant_id, variant_id)`                        | the concrete option selection that defines this SKU; FK → `option_value`.                                                                                                                                                                                                                                                                                                                      |

### C.6 Task 3.5 — identifiers (tenant-scoped)

| Table             | tenant | RLS            | Unique                                                                      | Indexes                                                     | Notes                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ----------------- | :----: | -------------- | --------------------------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `item_identifier` |   ✅   | ENABLE + FORCE | **`(tenant_id, code_type, value)`** (a scan resolves to exactly one target) | `(tenant_id, target_kind, target_id)`, `(tenant_id, value)` | `target_kind text CHECK (∈ VARIANT, INVENTORY_ITEM)` (`INVENTORY_ITEM` is a **forward value** — no `inventory_item` table in Phase 3; a Phase-3 identifier always targets a `VARIANT`); `target_id uuid`; `code_type text CHECK (∈ SKU, BARCODE, QR)`; `value text`; `pack_uom_code text` + `pack_qty numeric(18,4)` (nullable — a per-pack-level identifier, e.g. a box-of-12 barcode); `status` (`ACTIVE`/`INACTIVE`). |

### C.7 Task 3.6 — UOM configuration + conversions (tenant-scoped)

| Table                   |              tenant              | RLS                        | Unique                                                          | Indexes                             | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ----------------------- | :------------------------------: | -------------------------- | --------------------------------------------------------------- | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `uom`                   |                ✅                | ENABLE + FORCE             | `(tenant_id, code)`                                             | `(tenant_id)`                       | `code text`; `family text CHECK (∈ LENGTH, MASS, VOLUME, COUNT, EACH)` (mirrors `@flower/uom` `UomFamily`); `per_base_num bigint` / `per_base_den bigint` (both `> 0`, a `CHECK`); `max_decimals smallint CHECK (0..4)` **with `CHECK (family <> 'COUNT' OR max_decimals = 0)`** (D0-1 / `@flower/uom` — COUNT is strictly discrete); `name_en`/`name_ar`. Built-in units (`meter`, `gram`, `piece`…) are provided by `@flower/uom`'s `BUILTIN` and need **no** row — a tenant `uom` row is only for a tenant-specific unit (a foam block, a 25 kg bag). |
| `uom_conversion`        |                ✅                | ENABLE + FORCE             | `(tenant_id, scope_kind, scope_id, from_uom_code, to_uom_code)` | `(tenant_id, scope_kind, scope_id)` | **item/variant-scoped only** (D0-1): `scope_kind text CHECK (∈ VARIANT, PRODUCT)`, `scope_id uuid`; `from_uom_code` / `to_uom_code` (both must be a `@flower/uom` built-in or a registered tenant `uom` — validated by the service against `UomRegistry`); `num bigint` / `den bigint` (`> 0`, `CHECK`). A row **may** cross families (e.g. `roll → meter`) **because it is scoped to one variant/product** — there is **no global cross-family row** (`scope_kind` has no `GLOBAL` value).                                                              |
| `variant.base_uom_code` | _(additive column on `variant`)_ | _(inherits `variant` RLS)_ | —                                                               | —                                   | the canonical base UOM for the variant. Every price and every future stock quantity normalises to this. Populated in Task 3.6; then made `NOT NULL`.                                                                                                                                                                                                                                                                                                                                                                                                     |

**Domain wiring (Task 3.6, no arithmetic re-implemented):** the catalog service
builds a `UomRegistry({ units: <tenant uom rows>, conversions: <variant/product
uom_conversion rows> })` from `@flower/uom` and calls `registry.convert(...)` /
`registry.assertPermitted(...)`. The eager validation `@flower/uom` added in Task
3.0 (num/den > 0, referenced units registered, COUNT discrete) runs at registry
construction and is surfaced as a `422` on a bad `uom` / `uom_conversion` write.

### C.8 Task 3.7 — per-UOM pricing (tenant-scoped)

| Table               | tenant | company |           branch           | RLS            | Unique                                                                                                            | Indexes                   | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------- | :----: | :-----: | :------------------------: | -------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `variant_uom_price` |   ✅   |    —    | _(branch column nullable)_ | ENABLE + FORCE | `(tenant_id, variant_id, uom_code, COALESCE(branch_id,'00000000-…'))` — one price per (variant, UOM, branch/null) | `(tenant_id, variant_id)` | `uom_code` (must be the variant's `base_uom_code` **or** a UOM reachable from it via a conversion — validated); `sell_amount_minor bigint` + `sell_currency_code text` + `sell_currency_exponent smallint` (the **selling price for this UOM tier** — **not** `base_price × factor`, D0-1 / ADR-0018 §5); `purchase_amount_minor bigint?` + `purchase_currency_code text?` + `purchase_currency_exponent smallint?` (**foundation-only — nullable, may be written by an Owner but is not consumed anywhere in Phase 3**; Phase 5 procurement wires it. Its presence now means Phase 5 needs **no** schema change to add UOM-specific cost); `branch_id uuid?` (nullable — a `NULL` row is the tenant default; a non-null row is a per-branch override — the catalog price overlay, distinct from `branch_variant_price` which is the _branch_ module's view of the same override — **Open Owner Decision I.5** picks one table or both). `currency_exponent` columns carry a `CHECK` against a small helper or are asserted equal to `currencyExponent(currency_code)` at write time (§C.10). The **base-UOM price is the always-present default** — a variant must have at least a `(variant, base_uom_code, NULL)` row before it can go `ACTIVE`. |

**Price-resolution service (Task 3.7):** given `(variant_id, uom_code, branch_id?,
currency)` → the effective `Money` sell price. Precedence:
`branch_variant_price` (Task 3.8) → `variant_uom_price` with matching `branch_id`
→ `variant_uom_price` with `branch_id = NULL` (tenant default) → (if the
requested `uom_code` has no explicit row) **error** — Phase 3 does **not**
derive a per-UOM price by multiplication (D0-1). Currency must equal the
company's `default_currency` (a cross-currency price is a `422`).

### C.9 Task 3.8 — branch availability + branch price (tenant + branch)

| Table                         | tenant | company | branch | RLS                                                      | Unique                                         | Indexes                                             | Notes                                                                                                                                                                                                                                                                |
| ----------------------------- | :----: | :-----: | :----: | -------------------------------------------------------- | ---------------------------------------------- | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `branch_variant_availability` |   ✅   |    —    |   ✅   | ENABLE + FORCE (+ branch GUC filter where single-branch) | `(tenant_id, branch_id, variant_id)`           | `(tenant_id, branch_id)`, `(tenant_id, variant_id)` | `available boolean NOT NULL` — a **merchandising** flag (is this variant offered here), **not** a quantity. Absence of a row = a tenant-configurable default (`tenant_catalog_capability` holds `default_branch_availability`). **This is not branch stock (§A.4).** |
| `branch_variant_price`        |   ✅   |    —    |   ✅   | ENABLE + FORCE                                           | `(tenant_id, branch_id, variant_id, uom_code)` | `(tenant_id, branch_id)`                            | an optional per-branch override of the per-UOM sell price (money trio). Deletable (pure override). Gated by `branch_price:manage`.                                                                                                                                   |

### C.10 Money / UOM ↔ column mapping (binding)

| Value object   | Columns                                                                               | Read                                                                                                                                                                                                                   | Write                                                                                                                                                                                                                                                                                                                 |
| -------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Money`        | `<x>_amount_minor bigint`, `<x>_currency_code text`, `<x>_currency_exponent smallint` | `Money.ofMinor(BigInt(row.x_amount_minor), row.x_currency_code)` — the row's `x_currency_exponent` is **not** trusted for arithmetic; it is a wire convenience and **must** equal `currencyExponent(x_currency_code)`. | from `money.toDTO()` → the three columns. A write asserts `dto.exponent === currencyExponent(dto.currency)` (already guaranteed by `Money`) and that `dto.currency` is a **DB-enabled** currency for the company (D0-2), not merely known to `@flower/money`. Optional `CHECK (x_currency_exponent BETWEEN 0 AND 3)`. |
| `Quantity`     | `<x> numeric(18,4)`                                                                   | `Quantity.parse(row.x.toString())` (Prisma returns `Decimal`)                                                                                                                                                          | `quantity.toFixed4()` → the `numeric(18,4)` column. `@flower/uom`'s `QUANTITY_MAX/MIN_SCALED` bound is `±(10^18−1)`, which is exactly `numeric(18,4)`'s range.                                                                                                                                                        |
| tax rate (bps) | `rate_bps int` (reuses Task 2.7 `tax_rate.rate_bps`)                                  | —                                                                                                                                                                                                                      | `Money.percentage(rate_bps)` at computation time (Phase 3b).                                                                                                                                                                                                                                                          |

**DTO wire shapes are locked (Task 3.0):** money = `{ amountMinor: string,
currency, exponent }`; quantity = `{ amount: string }` with the **UOM code
carried separately** in the payload. Phase 3 controllers import
`moneyDtoSchema` / `quantityDtoSchema` from `@flower/shared-types` — no
hand-rolled money/quantity validation.

### C.11 Migration & baseline rules

- **Forward-only, expand/contract, additive.** No column removed/retyped on any
  Phase 0/1/2 table. New nullable → (backfill job where needed) → `NOT NULL` in a
  later step (`variant.base_uom_code`, `tenant.business_type_key` stays nullable).
- Each task's migration extends `packages/db/src/constants.ts`
  (`TENANT_SCOPED_TABLES` / `PLATFORM_GLOBAL_TABLES`) and the
  `packages/db` schema-baseline Testcontainers assertion + the RLS-coverage test.
- **`business_type_template`** is the only Phase 3a platform-global (RLS-exempt)
  table; every other new table is tenant-owned with `ENABLE + FORCE` + the
  `USING (tenant_id = nullif(current_setting('app.tenant_id', true),'')::uuid)`
  policy + matching `WITH CHECK`.
- **Partitioning:** none of the Phase 3a tables are high-volume append-only —
  **not partitioned**. (The `DB-CONVENTIONS.md` "Partitioning (from migration
  #1)" list — `order`, `journal_entry`, `payment_event`, … — is a **Phase 3b**
  concern and is factually stale for Phase 1's migration #1; **Open Owner
  Decision I.2** records the correction.)
- **`inventory_item`** is **not** created in Phase 3a. `item_identifier.target_kind`
  reserves the `INVENTORY_ITEM` value; Phase 5 adds the table + the
  `variant → inventory_item` link as an additive migration (**foundation-only
  reservation**, §H.1).

---

## D. API matrix (Phase 3a)

All routes are `/v1/...`, go through the **existing** guard pipeline
(auth → tenant-from-session → entitlement → permission (+ step-up) → company
scope → branch scope → resource → business rule → txn → audit-via-outbox), and
declare **either** `@RequirePermission(...)` **or** `@Public()` (a route with
neither fails lint — CLAUDE.md rule 9). Money/quantity request + response bodies
use the locked DTO shapes (§C.10). List endpoints inject a scope filter, never
reject.

| Task | Method + path                                                                                                                                                                               | Permission                                                   | `@ScopedParam`                         | Idempotency-Key                                                                                       | Notes                                                                                                                                 |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | -------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| 3.1  | `GET /v1/platform/business-type-templates`                                                                                                                                                  | `platform:tenants:view` (platform realm)                     | —                                      | —                                                                                                     | list the curated presets                                                                                                              |
| 3.1  | `PUT /v1/platform/tenants/:tenantId/catalog-capability`                                                                                                                                     | `platform:entitlements:manage` (platform realm, **step-up**) | —                                      | **required** (`catalog.capability.set`)                                                               | Super-Admin write of `tenant_catalog_capability` + `tenant.business_type_key`; audited `tenant.catalog_capability_changed` (security) |
| 3.1  | `GET /v1/catalog/capability`                                                                                                                                                                | `catalog:view`                                               | —                                      | —                                                                                                     | Owner **read** of the tenant's own enabled capabilities (drives UI)                                                                   |
| 3.2  | `POST/PUT/GET /v1/catalog/categories[/:id]` · `GET /v1/catalog/categories`                                                                                                                  | `catalog:manage` / `catalog:view`                            | —                                      | `catalog.category.create` on POST                                                                     | tree read is scope-filtered                                                                                                           |
| 3.2  | `POST/PUT/GET /v1/catalog/product-types[/:id]`                                                                                                                                              | `catalog:manage` / `catalog:view`                            | —                                      | `catalog.product_type.create`                                                                         |                                                                                                                                       |
| 3.2  | `POST /v1/catalog/products` · `PUT /v1/catalog/products/:id` · `POST /v1/catalog/products/:id/activate` · `POST /v1/catalog/products/:id/archive` · `GET /v1/catalog/products[/:id]`        | `catalog:manage` / `catalog:view`                            | —                                      | `catalog.product.create` (POST), `catalog.product.update` (PUT — or `If-Match` version, **Open I.7**) | `activate` is gated: rejects if `fulfilment_strategy` not enabled in capability, or no base-UOM price (3.7), etc.                     |
| 3.3  | `POST/PUT/GET /v1/catalog/attribute-definitions[/:id]` + `/options`                                                                                                                         | `catalog:manage` / `catalog:view`                            | —                                      | `catalog.attribute_definition.create`                                                                 |                                                                                                                                       |
| 3.3  | `PUT /v1/catalog/products/:id/attributes`                                                                                                                                                   | `catalog:manage`                                             | —                                      | `catalog.product.attributes.set`                                                                      | replace-set of typed values                                                                                                           |
| 3.4  | `POST/PUT/GET /v1/catalog/products/:id/option-groups` + `/values`                                                                                                                           | `variants:manage`                                            | —                                      | `catalog.option_group.create`                                                                         |                                                                                                                                       |
| 3.4  | `POST /v1/catalog/products/:id/variants` · `PUT /v1/catalog/variants/:id` · `POST /v1/catalog/variants/:id/{activate,archive}` · `GET`                                                      | `variants:manage` / `catalog:view`                           | —                                      | `catalog.variant.create`                                                                              | `If-Match: <version>` on `PUT` (`409` on mismatch — API-CONVENTIONS §Concurrency)                                                     |
| 3.5  | `POST /v1/catalog/identifiers` · `DELETE /v1/catalog/identifiers/:id` · `GET /v1/catalog/identifiers?value=…` (resolve a scan)                                                              | `identifiers:manage` / `catalog:view`                        | —                                      | `catalog.identifier.create`                                                                           | resolve returns the target variant + product; `409` on a duplicate `(code_type, value)`                                               |
| 3.6  | `POST/PUT/DELETE/GET /v1/catalog/uoms[/:code]`                                                                                                                                              | `catalog:manage` / `catalog:view`                            | —                                      | `catalog.uom.create`                                                                                  | `422` if `@flower/uom` `UomRegistry` rejects the def (COUNT not discrete, non-positive perBase…)                                      |
| 3.6  | `PUT /v1/catalog/variants/:id/conversions` (replace-set of variant-scoped `uom_conversion`) · `PUT /v1/catalog/variants/:id/base-uom`                                                       | `variants:manage`                                            | —                                      | `catalog.variant.conversions.set`                                                                     | `422` on an invalid ratio / unregistered unit                                                                                         |
| 3.7  | `PUT /v1/catalog/variants/:id/prices` (replace-set of `variant_uom_price`) · `GET /v1/catalog/variants/:id/prices?branchId=&uom=&currency=` (resolved price)                                | `pricing:manage` / `catalog:view`                            | —                                      | `catalog.variant.prices.set`                                                                          | `422` on a cross-currency price or a not-DB-enabled currency (D0-2)                                                                   |
| 3.8  | `PUT /v1/catalog/branches/:branchId/availability` (bulk set of variant flags) · `GET /v1/catalog/branches/:branchId/catalog` (the branch-effective catalog: availability + resolved prices) | `branch_price:manage` (write) / `catalog:view` (read)        | `@ScopedParam({ branch: 'branchId' })` | `catalog.branch.availability.set`                                                                     | branch-scoped user sees only granted branches                                                                                         |
| 3.8  | `PUT /v1/catalog/branches/:branchId/prices` (branch price overrides)                                                                                                                        | `branch_price:manage`                                        | `@ScopedParam({ branch: 'branchId' })` | `catalog.branch.prices.set`                                                                           |                                                                                                                                       |
| 3.9  | `GET /v1/catalog/variants/:id/tax` (resolved tax category + current rate for the company's country/date)                                                                                    | `catalog:view`                                               | —                                      | —                                                                                                     | reads Task 2.7 reference data via `LocalizationService`/`TaxResolutionService` — **no computation on an amount**                      |
| 3.10 | `POST /v1/platform/tenants/:tenantId/apply-business-type-template`                                                                                                                          | `platform:entitlements:manage` (platform, step-up)           | —                                      | **required** (`catalog.template.apply`)                                                               | additive seed of categories/attributes/UOMs from the tenant's template — never deletes/disables existing config (ADR-0018 §1)         |

**Idempotency rule:** every **create** (POST that produces a new resource) and
every **bulk replace-set** (`PUT …/prices`, `…/conversions`, `…/attributes`,
`…/availability`) **requires** `Idempotency-Key` (`@Idempotent({ scope })`,
canonical scope names above). A simple field-level `PUT /:id` update uses
`If-Match: <version>` optimistic concurrency instead (**Open Owner Decision I.7**
picks the rule per route). **No** catalog route is on an auth/credential family,
so the `assertNoIdempotencyOnCredentialRoutes` startup check is satisfied.

---

## E. Permission / entitlement matrix

### E.1 Permissions

The `@flower/permissions` **representative catalogue already contains** the
catalog keys — Phase 3a **activates** (seeds into `permission_registry` + assigns
to the seeded system roles) this subset and **adds** the new ones:

| Key                                  | Group                                                                      | Status                | Used by                                                                                                            |
| ------------------------------------ | -------------------------------------------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `catalog:view`                       | `catalog`                                                                  | **activate** (exists) | every catalog read                                                                                                 |
| `catalog:manage`                     | `catalog`                                                                  | **activate** (exists) | categories, product types, products, attributes, UOMs                                                              |
| `variants:manage`                    | `catalog`                                                                  | **activate** (exists) | option groups, variants, conversions, base-UOM                                                                     |
| `pricing:manage`                     | `catalog`                                                                  | **activate** (exists) | `variant_uom_price`                                                                                                |
| `branch_price:manage`                | `catalog`                                                                  | **activate** (exists) | branch availability + branch price                                                                                 |
| `identifiers:manage`                 | `inventory` group today → **move/duplicate into `catalog`** (**Open I.3**) | **activate**          | `item_identifier`                                                                                                  |
| `platform:catalog_capability:manage` | platform realm — **NEW**                                                   | **add**               | the Super-Admin capability-config + template-apply routes (or reuse `platform:entitlements:manage` — **Open I.3**) |

`promotions:manage` (exists) is **NOT** activated — promotions are Phase 7/10.

**Step-up (MFA):** the Super-Admin capability/template routes are step-up-gated
(they change what a tenant may sell — same class as an entitlement override).
Ordinary catalog CRUD is **not** step-up-gated. Add the platform capability key to
`STEP_UP_PERMISSIONS` in `@flower/permissions`.

**`MODULE_OF_PERMISSION`:** `catalog:*` / `variants:*` / `pricing:*` /
`branch_price:*` / `identifiers:*` map to the **`catalog`** module (always
entitled — a foundation module). A `custom_composition`-gated capability check is
done in the service, not via `MODULE_OF_PERMISSION` (the module toggle exists for
Phase 6's composition domain, not for Phase 3a catalog CRUD).

### E.2 Entitlements / capabilities

| Layer                                                                                                                                                     | Mechanism                                                                                         | Enforced where                                                                                                                                      |
| --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Coarse module** — `catalog` (always on), `production_bom` (existing toggle), `custom_composition` (**new** toggle)                                      | `entitlement_default` / `tenant_entitlement` + `policy-engine.ts` step 5 (`MODULE_OF_PERMISSION`) | the guard pipeline                                                                                                                                  |
| **Fine capability** — which `fulfilment_strategy` values, which templates, POS-visible / Customer-Web-visible per capability, inventory-behaviour toggles | `tenant_catalog_capability` (Task 3.1), Super-Admin write only                                    | the **catalog service** at write time (e.g. `POST /products` with `fulfilment_strategy = CUSTOM` → `403 CAPABILITY_NOT_ENABLED` if `CUSTOM` is off) |
| **Business Type**                                                                                                                                         | `tenant.business_type_key` + `business_type_template`                                             | **template application only** (Task 3.1 / 3.10) — never a runtime branch (D0-3, HG3-NO-BT-BRANCH)                                                   |

Owner/Admin/Manager operate **only within** entitlement ∩ permission ∩ company
scope ∩ branch scope — unchanged four-axis model.

---

## F. Event / realtime matrix

Publisher: the catalog service writes an `outbox` row **in the same DB
transaction** as the mutation (existing `OutboxWriter`). Downstream is the
existing Task 2.4→2.5→2.6 pipeline, unchanged. Envelope = the frozen ADR-0017 §3
fields (`event_id`, `seq`, `tenant_id`, `branch_id`, `type`, `resource_type`,
`resource_id`, `resource_version`, `occurred_at`, `actor_summary`) — **never the
payload**. Events are tenant-isolated, branch-authorised by the gateway,
`event_id`-deduped, resumable via the existing cursor.

| Event `type`                           | When                                                                            | `branch_id`                                                   | Consumer / why                                           | Volume                       |
| -------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------- | -------------------------------------------------------- | ---------------------------- |
| `catalog.variant.price_changed`        | a `variant_uom_price` or `branch_variant_price` change on an **ACTIVE** variant | the affected branch (branch price) or `null` (tenant default) | same-branch POS refreshes the price of an item on screen | low — deliberate price edits |
| `catalog.variant.availability_changed` | `branch_variant_availability.available` toggled for an ACTIVE variant           | the branch                                                    | POS greys out / restores an item                         | low                          |
| `catalog.variant.status_changed`       | a variant goes `ACTIVE` ↔ `ARCHIVED`                                            | `null` (tenant-wide)                                          | POS adds/removes the item from the sellable list         | low                          |
| `catalog.product.status_changed`       | a product goes `ACTIVE` ↔ `ARCHIVED`                                            | `null`                                                        | POS list refresh                                         | low                          |

**Not published** (POS refetches on demand / next session — publishing would be
high-volume or low-value): `DRAFT` product/variant edits, category tree edits,
attribute-definition edits, identifier add/remove, UOM/conversion edits, a
capability change (Super-Admin action — the Owner UI refetches). The exact final
event set is a **Task 3.10 deliverable** confirmed against "what a POS screen
genuinely must react to live". **No** new topic, channel, or transport.

---

## G. Hard-gate matrix (Phase 3a — all build-blocking at the task that introduces them)

| Gate                             | Assertion                                                                                                                                                                                                                                                                                                                                                                                    |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **HG3-MONEY**                    | Every Phase 3 money value goes through `@flower/money`; no floating point; no duplicated currency-exponent logic; the `packages/db` `Currency`-exponent parity test stays green and build-blocking; a DB currency not in `@flower/money` (or with a mismatched exponent) fails the parity test.                                                                                              |
| **HG3-UOM**                      | Every Phase 3 quantity/conversion goes through `@flower/uom`; **no conversion arithmetic re-implemented** in any API/domain module (a source scan / review check); a `uom` / `uom_conversion` write that `UomRegistry` rejects is a `422`; `COUNT` units are discrete; **no global cross-family conversion row** exists (`uom_conversion.scope_kind` has no `GLOBAL` value — schema + test). |
| **HG3-GENERIC-CATALOG**          | No `FlowerProduct`/`PerfumeProduct`/`BakeryProduct`-style entity, table, service, or file; no per-business-type inventory/pricing engine; `product`/`variant` have no vertical-specific nullable columns (vertical data is `product_attribute_value`); one `product → … → variant → price` pipeline. Boundary lint + review.                                                                 |
| **HG3-NO-BT-BRANCH**             | No code path reads `tenant.business_type_key` (or a business-type label) to branch behaviour — a repo scan for `businessType`/`business_type` outside the template-application code + a review check; `business_type_key` is used only to select a template at apply time.                                                                                                                   |
| **HG3-PER-UOM-PRICE**            | A per-UOM sale price is an independent stored value, never `base_price × conversion_factor` (test: a Box-of-12 priced ≠ 12 × Piece resolves to the stored Box price); the base-UOM price is always present before `ACTIVE`; a price resolution never invents a price for an unpriced UOM.                                                                                                    |
| **HG3-CATALOG-SCOPE-SEPARATION** | Catalog definition (tenant), branch availability (tenant+branch), branch price (tenant+branch) and branch stock (**absent** in Phase 3a) are distinct — a test proves branch availability is a flag not a quantity, and that no Phase 3a table stores a stock balance.                                                                                                                       |
| **HG3-RLS**                      | RLS `ENABLE + FORCE` + policy on every new tenant-owned table; `business_type_template` correctly RLS-exempt (`flower_app` SELECT-only); a no-GUC scoped query returns 0 rows on every new table; `flower_app` still `NOSUPERUSER NOBYPASSRLS`.                                                                                                                                              |
| **HG3-TENANT-ISOLATION**         | The Phase 1 cross-tenant probe suite stays green and is **extended to every new Phase 3a endpoint** (act as tenant B, try tenant A's category/product/variant/price/identifier by id/param/URL → 403/404 or zero rows); still mutation-tested ("teeth").                                                                                                                                     |
| **HG3-BRANCH-ISOLATION**         | **The `TESTING-STRATEGY.md` branch-isolation probe suite is introduced here (Phase 3), build-blocking** — a Dubai-scoped user cannot read/write Sharjah branch availability or branch prices; a multi-branch user sees only granted branches; a POS terminal id confers no cross-branch reach.                                                                                               |
| **HG3-CAPABILITY**               | A create is rejected when its `fulfilment_strategy` / template is not enabled in `tenant_catalog_capability`; only Super Admin (platform realm, step-up) can write the capability config; Owner/Admin/POS cannot; a disabled capability's UI is inert (contract).                                                                                                                            |
| **HG3-IDEM**                     | Every catalog **create** and **bulk replace-set** route requires `Idempotency-Key` and replays a stored `2xx` on retry (different hash → 409); no catalog route is on a credential family.                                                                                                                                                                                                   |
| **HG3-AUDIT**                    | Every capability change, template application, and (per the registry decision, **Open I.8**) product/variant/price lifecycle change writes an `audit_log` record via the existing `AuditWriter` against a **registered** `AUDITABLE_ACTIONS` key (a new mutation cannot ship without its audit entry — `actions.test.ts` enforces the closed set).                                           |
| **HG3-REALTIME-AUTHZ**           | Catalog events publish via the existing outbox→relay→gateway path; a branch-Y socket never receives a branch-X `catalog.*` event; a tenant-B socket never receives a tenant-A event; duplicate `event_id` suppressed; the realtime acceptance suite stays green.                                                                                                                             |
| **HG3-NO-PREMATURE-DOMAIN**      | No inventory movement/balance/reservation, no BOM/recipe/composition, no order/payment/GL/receivable/settlement/cancellation table or code, no Z-report, no storefront, no POS checkout engine. Boundary lint + review (§H).                                                                                                                                                                 |
| **HG3-REGRESSION**               | The full Phase 0–2-core suite (`turbo run test` — currently 34 tasks / api 171 · worker 87 · realtime 44 · scheduler 12 · db 43 · backend 17 · spike-rls 21 · money 49 · uom 42 · …) stays green after every Phase 3a task.                                                                                                                                                                  |
| **HG3-CI**                       | GitHub CI `verify` + `security` + `e2e` + `realtime` green on every Phase 3a PR; `security-review` (cumulative from `phase-2-core-complete` → the task HEAD) has no open Critical/High.                                                                                                                                                                                                      |

---

## H. Later-phase / non-scope matrix

### H.1 Explicitly OUT of Phase 3a (built later; the roadmap phase is noted)

| Item                                                                                                       | Phase  | Foundation-only hook in Phase 3a?                                                                                                                                                                                                  |
| ---------------------------------------------------------------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Inventory movement ledger, `branch_inventory_balance`, stock adjustment                                    | 5      | **No table.** `item_identifier.target_kind` reserves the `INVENTORY_ITEM` value; `variant.base_uom_code` is the normalisation anchor Phase 5 will use.                                                                             |
| Batch / lot / expiry / FEFO                                                                                | 5      | **Stored not enforced:** `tenant_catalog_capability` carries `lot_batch` / `expiry` toggles (ADR-0018 generalises Z-11); no `lot` table, no enforcement.                                                                           |
| Purchase receiving, `goods_receipt`, supplier bill / documents                                             | 5      | `variant_uom_price.purchase_*` columns exist (nullable, unconsumed) so Phase 5 needs no schema change for UOM-specific cost.                                                                                                       |
| BOM / recipe / bouquet composition / hamper composition                                                    | 6      | `product.fulfilment_strategy` already models `BOM` / `CUSTOM`; a `BOM`/`CUSTOM` product may exist in Phase 3a with **no** recipe/composition (it just can't be sold until Phase 6). `custom_composition` entitlement module added. |
| Production / work orders / wastage / spoilage                                                              | 6      | none                                                                                                                                                                                                                               |
| **Orders, order lines, the walk-in sale, gapless numbering**                                               | 3b     | The **catalog price/tax resolution services** (3.7 / 3.9) are the read APIs a Phase 3b order will call to snapshot line price + tax. No `order` table in 3a.                                                                       |
| **Payments, provider adapter, webhooks**                                                                   | 3b     | `provider_credential` (Phase 1 vault shell) already exists; no payment table in 3a.                                                                                                                                                |
| **Accounting / GL / posting engine / CoA / periods**                                                       | 3b     | none — but see §H.2 for the ADR-0019 constraints 3a schema must respect.                                                                                                                                                           |
| **Receivables / credit / advances / gift cards**                                                           | 3b     | none                                                                                                                                                                                                                               |
| **Customer settlement / allocation / settlement discount**                                                 | 3b     | §H.2                                                                                                                                                                                                                               |
| **Cancellation / refund / cancellation charge / account credit**                                           | 3b     | §H.2                                                                                                                                                                                                                               |
| **Customer financial subledger (`ar_transaction` / `advance_transaction`)**                                | 3b     | none                                                                                                                                                                                                                               |
| Z-Report, cash register, POS shift, X-Report, expenses                                                     | 4      | none                                                                                                                                                                                                                               |
| Customer Web storefront, online-order queue, delivery                                                      | 7      | `product.customer_web_visible` capability flag exists (Task 3.1) so Phase 7's published-catalog projection has a source of truth; no storefront code.                                                                              |
| Promotions / coupons / loyalty / subscriptions                                                             | 7 / 10 | `promotions:manage` permission stays inert; no table.                                                                                                                                                                              |
| Full **cart tax-calculation engine** (inclusive/exclusive, per-invoice rounding, credit-note tax reversal) | 3b     | 3a ships tax **category on the catalog** + rate **resolution** only (**Open I.6**).                                                                                                                                                |

### H.2 ADR-0019 structural constraints Phase 3a must not violate

Phase 3a builds no receivables/settlement/cancellation/GL code, but its schema
choices must leave room for ADR-0019:

1. **"Invoice" vs `order` is undecided** (ADR-0019, deferred to Phase 3b
   modelling). Phase 3a must **not** put anything invoice/receivable-shaped on a
   catalog table. A Phase 3b order line will carry a **price + tax + discount
   snapshot** — so the catalog price/tax resolution services (3.7/3.9) must
   return a **self-contained, snapshottable** result (variant id + uom + resolved
   money + tax category + rate + effective date), never a reference that has to
   be re-resolved later.
2. **`payment` and `payment_allocation` are separate rows** (ADR-0019 §8) — a
   Phase 3b concern; Phase 3a introduces nothing that presumes "payment =
   applied".
3. **`settlement` is a header with no value column** (ADR-0019 §9) — Phase 3a
   introduces no settlement concept.
4. **Account credit = `ADVANCE` with a `source_kind` reference** (ADR-0019 §31) —
   no parallel balance concept; Phase 3a introduces no customer balance.
5. **Six independent lifecycle states** (order / invoice-payment / payment /
   receivable / refund / inventory-disposition) — Phase 3a's `product`/`variant`
   `status` lifecycle (`DRAFT/ACTIVE/ARCHIVED`) is a **seventh, unrelated** axis
   (catalog lifecycle) and must never be conflated with any of the six.
6. **The customer subledger is append-only, projections are derived** — Phase 3a
   stores no derived money balance anywhere; `variant_uom_price` is a
   configuration value, not a running balance.
7. **Contra-revenue discount separation** (ZF-7 / ADR-0019 §13/§26) — Phase 3a
   models **no** discount. A "sale discount" is a Phase 3b order concept; a
   "settlement discount" / "cancellation charge" is later still. `product`/
   `variant` carry no discount column.

### H.3 Phase 3b task outline (NOT scheduled here — a later plan)

For context only, to show the split is coherent (each is its own STOP-and-approve
task; ADR-0019's detail is designed **in this later plan**, not now):

3b.1 CoA + posting engine skeleton (`account`, `accounting_period`, account-key
resolution, `journal_entry`/`journal_line` with the balanced-entry constraint +
`UNIQUE(source_kind, source_id)`, default-CoA seed on provisioning) · 3b.2 CRM
core (`customer` + credit fields as **derived**) · 3b.3 Orders (`order`,
`order_line` with price/tax/discount **snapshot**, walk-in state machine, gapless
numbering inside the txn) · 3b.4 Tax computation on a line/order + rounding policy
· 3b.5 Payments (`PaymentProvider` port + 1 adapter, `payment` + `payment_allocation`
as **separate** rows, webhook idempotent on the provider event id) · 3b.6
Receivables (`invoice_payment_status` derivation, `ar_transaction`/
`advance_transaction` subledger + reconciliation job) · 3b.7 Settlement (header
only, AUTO-FIFO via `Money.capAllocate`, manual + discount toggles) · 3b.8
Cancellation / refund / cancellation-charge policy engine · 3b.9 The **atomic
walk-in sale** (order + payment + allocation + **synchronous journal posting** +
audit, one txn + one outbox event; realtime `order.*` / `payment.updated`) ·
3b.10 First reporting rollups (`rpt_sales_daily`, `rpt_payment_daily`,
`rpt_ar_aging`, `rpt_gl_account_period`) · 3b.11 verification + `phase-3-complete`.

---

## I. Open owner decisions

| #        | Decision                                                                                                                                                                                                                                                                                                                                                   | Recommendation                                                                                                                                                                                                                                                                                                                |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **I.1**  | **Phase 3a / 3b split** — detail catalog now (this plan) and write a separate Phase 3b plan after `phase-3a-catalog-complete`, **OR** one long Phase 3 task sequence through the walk-in sale.                                                                                                                                                             | **Split** (this plan assumes it) — the financial half is large, ADR-0019-heavy, and benefits from its own planning pass; the roadmap's dependency order and exit criteria are unchanged, only the planning is staged.                                                                                                         |
| **I.2**  | **Partitioning correction** — record in this plan that `DB-CONVENTIONS.md` / `DOMAIN-MODEL.md` "Partitioning (from migration #1)" is stale (Phase 1 migration #1 created none of `order`/`journal_*`; `idempotency_key` was de-partitioned in Task 2.1); Phase 3a tables are unpartitioned; Phase 3b decides `order`/`journal_*` partitioning at creation. | Accept the correction as written; the conventions doc gets a one-line amendment in Task 3.1.                                                                                                                                                                                                                                  |
| **I.3**  | **`identifiers:manage` group + the Super-Admin capability permission key.** Move/duplicate `identifiers:manage` into the `catalog` group? Add a new `platform:catalog_capability:manage` key, or reuse `platform:entitlements:manage`?                                                                                                                     | Duplicate `identifiers:manage` into `catalog`; **add** `platform:catalog_capability:manage` (distinct from generic entitlement management, so it can be granted independently).                                                                                                                                               |
| **I.4**  | **Product media in Phase 3a** — a minimal `media jsonb` URL list, or wait for the real `documents` domain integration (Phase 5 `files`)?                                                                                                                                                                                                                   | Minimal `media jsonb` (external URL refs) now; migrate to `documents` (`owner_type = PRODUCT`) when `files` lands — no schema break (the column stays, the values point at signed URLs later).                                                                                                                                |
| **I.5**  | **Per-branch price: one table or two?** `variant_uom_price.branch_id` (nullable, the pricing module's view) **and** `branch_variant_price` (the branch module's view) both model a per-branch price override.                                                                                                                                              | **One table** — `variant_uom_price` with a nullable `branch_id`; the "branch price" API (Task 3.8) writes rows with `branch_id` set. Drop `branch_variant_price`. (Simpler; one resolution path.)                                                                                                                             |
| **I.6**  | **Tax in Phase 3a vs 3b.** 3a ships `tax_category` on the catalog + a rate-**resolution** service; the line/cart tax **computation** + rounding policy is 3b (with orders). Confirm — or pull a minimal line-tax computation into 3a.                                                                                                                      | 3a = category + resolution only; 3b = computation + rounding policy. The roadmap schedules "price + tax resolution" in Phase 3 (satisfied by 3a's resolution) and "tax per country" tests (satisfied by resolving the right rate per `company.country_code`); a full computation engine is not "resolution".                  |
| **I.7**  | **Idempotency vs `If-Match` per route.** Which catalog mutations require `Idempotency-Key` (creates + bulk replace-sets) vs `If-Match: <version>` optimistic concurrency (field-level `PUT /:id`)?                                                                                                                                                         | Creates + bulk replace-sets → `Idempotency-Key` (required). Field-level `PUT /:id` on a versioned aggregate (`product`, `variant`) → `If-Match`. Both may apply to a bulk set on a versioned aggregate.                                                                                                                       |
| **I.8**  | **Audit registry scope for catalog.** Which catalog mutations get an `AUDITABLE_ACTIONS` entry — all lifecycle + price + capability changes, or a narrower set?                                                                                                                                                                                            | At minimum: `tenant.catalog_capability_changed` (security), `catalog.template_applied`, `catalog.product.status_changed`, `catalog.variant.status_changed`, `catalog.variant.prices_changed`, `catalog.branch_price_changed`, `catalog.branch_availability_changed`. Ordinary DRAFT edits: not audited (activity, not audit). |
| **I.9**  | **`inventory_item` shell in Phase 3a?** Create a minimal `inventory_item` (id, tenant, kind, name, base_uom_code, flags) as the `STOCKED` variant link target now, or let `variant.base_uom_code` stand alone and add `inventory_item` + the FK in Phase 5?                                                                                                | **Defer** — `variant.base_uom_code` is sufficient for Phase 3a catalog/pricing; Phase 5 adds `inventory_item` + `variant.inventory_item_id` as an additive migration. `item_identifier.target_kind` already reserves `INVENTORY_ITEM`.                                                                                        |
| **I.10** | **`tenant_catalog_capability` shape** — one JSON config row per tenant, or one row per (tenant, capability)?                                                                                                                                                                                                                                               | One row per tenant with a typed `jsonb` config (fewer rows, atomic Super-Admin write, matches `tenant_setting` precedent). Task 3.1 finalises the JSON schema.                                                                                                                                                                |
| **I.11** | **Business-Type preset list** — beyond "exclude Jewellery/Accessories and Mobile/Mobile-Accessories", confirm the exact set + each template's seed payload (categories, attribute templates, UOM templates, capability preset).                                                                                                                            | Task 3.1 proposes the concrete list + payloads for owner sign-off before the seed lands.                                                                                                                                                                                                                                      |

---

## J. Proposed first implementation task (after this plan is approved)

> **Task 3.1 — Catalog capability & Business-Type template foundation.**

| Field                           | Detail                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Goal**                        | Super Admin can, per tenant, configure which catalog capabilities/templates that tenant may use; the Owner can read its own enabled capabilities; the concrete Business-Type preset list + seed payloads are agreed. **No product data, no catalog CRUD yet.**                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **Scope**                       | `business_type_template` (platform-global reference + curated seed, preset list excludes Jewellery/Mobile) · `tenant_catalog_capability` (tenant-scoped, Super-Admin write only) · `tenant.business_type_key` additive nullable FK · new entitlement module `custom_composition` (+ `catalog` marked always-on) · `platform:catalog_capability:manage` permission key (+ step-up) · the 3 APIs (`GET /v1/platform/business-type-templates`, `PUT /v1/platform/tenants/:tenantId/catalog-capability`, `GET /v1/catalog/capability`) · the capability-check helper the later catalog tasks will call · provisioning gains one step (apply the tenant's template defaults — additive, non-destructive). |
| **Models / tables**             | `business_type_template` · `tenant_catalog_capability` · `tenant.business_type_key` (column)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **APIs**                        | the 3 routes in §D row "3.1"                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **Permissions**                 | `platform:catalog_capability:manage` (NEW, platform realm, step-up) · `catalog:view` (activate — for the Owner read)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **Entitlements / capabilities** | add `custom_composition` to `ENTITLEMENT_MODULES` / `entitlement_default`; `catalog` is a foundation module (always entitled); the fine capability config lives in `tenant_catalog_capability`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **RLS / isolation**             | `tenant_catalog_capability` — `ENABLE + FORCE` + tenant policy; `business_type_template` — RLS-exempt, `flower_app` SELECT-only, platform write path; a no-GUC read of `tenant_catalog_capability` returns 0 rows                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **Idempotency**                 | `PUT …/catalog-capability` → `@Idempotent({ scope: 'catalog.capability.set' })` (required)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **Audit**                       | `tenant.catalog_capability_changed` (NEW `AUDITABLE_ACTIONS` key, `security: true`) via `AuditWriter`, in the write txn                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| **Outbox / realtime**           | none — a Super-Admin config change; the Owner UI refetches. (No `catalog.*` event yet.)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| **Tests**                       | unit: the capability-check helper truth table; integration (Testcontainers): Super-Admin write persists + is audited; a tenant user gets 403 on the write route; a no-GUC read returns nothing; RLS `ENABLE + FORCE` asserted; `business_type_template` readable by `flower_app` with no GUC, not writable; provisioning applies the template additively (re-apply never deletes); the schema-baseline + `TENANT_SCOPED_TABLES`/`PLATFORM_GLOBAL_TABLES` tests updated; the cross-tenant probe suite extended to the new endpoints; full Phase 0–2-core regression green                                                                                                                             |
| **Hard gate**                   | HG3-CAPABILITY (partial — the config + enforcement helper) · HG3-RLS · HG3-TENANT-ISOLATION · HG3-NO-BT-BRANCH (the template is applied, never branched on) · HG3-IDEM · HG3-AUDIT · HG3-REGRESSION · HG3-CI                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **Explicit non-scope**          | no `category`/`product`/`variant`/`attribute`/`uom`/`price` table or API; no catalog CRUD; no realtime; no Phase 3b anything; the capability _enforcement_ on a product create lands in Task 3.2 (Task 3.1 ships the helper + the config, 3.2 wires the first check)                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **Depends on**                  | Task 3.0 (done)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

---

## K. Documentation corrections this plan records (applied in Task 3.1)

1. **`DB-CONVENTIONS.md` / `DOMAIN-MODEL.md` "Partitioning (from migration #1)"** —
   amend to "declared here; each table is created and partitioned by its owning
   phase" (Open I.2).
2. **`@flower/permissions`** — activate the Phase-3 catalog subset; add
   `platform:catalog_capability:manage`; duplicate `identifiers:manage` into the
   `catalog` group (Open I.3).
3. **`@flower/shared-types` `ENTITLEMENT_MODULES`** — add `custom_composition`;
   note `catalog` is a foundation module (always on).
4. **`ROADMAP.md` §Phase 3** — a note that Phase 3 is executed as **3a
   (catalog)** then **3b (revenue path + financial truth)** with a
   `phase-3a-catalog-complete` checkpoint between (Open I.1); dependency order and
   exit criteria unchanged.
5. **`API-CONVENTIONS.md`** — already corrected in Task 3.0 (money = string
   `amountMinor`; quantity wire shape); no further change.

---

_End of PHASE-3-PLAN.md draft. Awaiting owner approval of the plan and of
Task 3.1. No Prisma migration, no Product/Category/Pricing runtime code, and no
Task 3.1 work has been started._
