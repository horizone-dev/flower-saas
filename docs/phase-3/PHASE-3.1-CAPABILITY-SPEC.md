# PHASE-3.1-CAPABILITY-SPEC.md — Catalog Capability & Business-Type Template Foundation

> **Status:** DRAFT — pre-migration owner sign-off document. **Documentation only.**
> No `schema.prisma` change, no migration, no runtime code is produced by this
> document. Task 3.1 implementation does not begin until this spec is approved.
>
> **Parent plan:** [`PHASE-3-PLAN.md`](./PHASE-3-PLAN.md) §J (Task 3.1),
> directionally approved and merged to `main` @ `193bce4`.
> **Approved `main` at authoring:** `193bce4e168911436afa4113a68aba19954bf804`.
>
> **Locked owner decisions applied (2026-09-06):** business-type required for new
> provisioning (§1) · CUSTOM is a data row, no special case (§2) · template
> capabilities normalized into their own table — 3 tables total (§3) · closed
> capability-key family with `channel.*` rename (§4) · preset default adjustments
> (§5) · no `catalog` entitlement module (§6) · `flower_app` SELECT-only on the
> config tables (§7) · Task 3.1 does initial apply only (§8) · re-apply removed
> from the Task 3.1 API, contract locked for Task 3.10 (§9) · `PATCH` change-set
> API with an explicit aggregate-version proposal (§10) · minimal Super Admin UI
> in Task 3.1 (§11) · one new permission (§12) · two audit actions (§13) · no
> realtime (§14) · capability service reads only `tenant_catalog_capability`
> (§15) · explicit `source_kind` provenance model (§16) · additive forward-only
> migration (§17).

---

## Table of contents

- [A. Final closed capability-key registry](#a-final-closed-capability-key-registry)
- [B. The 35 Business-Type presets](#b-the-35-business-type-presets)
- [C. Exact preset → capability matrix](#c-exact-preset--capability-matrix)
- [D. Entitlement dependency per capability](#d-entitlement-dependency-per-capability)
- [E. Config-JSON schema per capability](#e-config-json-schema-per-capability)
- [F. Normalized template schema](#f-normalized-template-schema)
- [G. Tenant capability schema](#g-tenant-capability-schema)
- [H. Provenance / override semantics](#h-provenance--override-semantics)
- [I. Initial template-apply algorithm](#i-initial-template-apply-algorithm)
- [J. Future re-apply merge / replace contract (Task 3.10)](#j-future-re-apply-merge--replace-contract-task-310)
- [K. API DTOs](#k-api-dtos)
- [L. Optimistic-concurrency proposal](#l-optimistic-concurrency-proposal)
- [M. Super Admin UI contract](#m-super-admin-ui-contract)
- [N. RLS / privilege matrix](#n-rls--privilege-matrix)
- [O. Audit actions](#o-audit-actions)
- [P. Hard gates / tests](#p-hard-gates--tests)
- [Q. Explicit non-scope](#q-explicit-non-scope)
- [R. Open items for owner sign-off](#r-open-items-for-owner-sign-off)

---

## 0. What Task 3.1 is

Task 3.1 stands up the **capability + Business-Type template configuration layer**
that must exist before any catalog-create endpoint (Task 3.2+). It delivers:

1. Three new tables — `business_type_template`, `business_type_template_capability`
   (both platform-global reference), `tenant_catalog_capability` (tenant runtime
   state).
2. Additive nullable columns on `tenant` for the Business-Type link + snapshot
   provenance (+ one aggregate-version column pending §L approval).
3. One new platform permission — `platform:catalog_capability:manage` (step-up).
4. One new entitlement module — `custom_composition` (referenced by
   `strategy.custom`; the entitlement axis is otherwise untouched).
5. Four APIs (two platform reads, one platform change-set `PATCH`, one tenant
   read).
6. A generic **initial template-apply** step inside the existing provisioning
   transaction — identical algorithm for all 35 presets, no per-key branch.
7. A typed **capability-check service** for Tasks 3.2–3.10 to consume.
8. A **minimal Super Admin capability-management surface** + the required
   Business-Type selector on the provisioning form.

It does **not**: write catalog data, gate a product create (that is Task 3.2),
publish any realtime event, implement template re-apply (Task 3.10), or introduce
any Phase 3b concept.

---

## A. Final closed capability-key registry

A **capability key** is a real runtime toggle a catalog/inventory/channel service
reads to decide whether a behaviour is available for a tenant. It is **not** a
template payload and **not** a provenance concept.

Keys are `lower.snake` with a `.`-separated family prefix. The registry is a
**closed set** — `packages/shared-types` exports a `CATALOG_CAPABILITY_KEYS`
tuple + `CapabilityKey` union; a write to any capability table with a key outside
the set is `422`.

| Key                      | Family     | Meaning                                                                | First runtime effect           |
| ------------------------ | ---------- | ---------------------------------------------------------------------- | ------------------------------ |
| `strategy.stocked`       | strategy   | the tenant may define `STOCKED` products (plain sellable items)        | Task 3.2 — product create gate |
| `strategy.bom`           | strategy   | the tenant may define `BOM` products (recipe / assembled)              | Task 3.2 gate; Phase 6 recipes |
| `strategy.custom`        | strategy   | the tenant may define `CUSTOM` products (composed at sale)             | Task 3.2 gate; Phase 6         |
| `variants`               | catalog    | option groups + multi-variant products are available                   | Task 3.4                       |
| `multi_uom`              | catalog    | multiple sell/purchase UOMs + item/variant conversions are available   | Task 3.6                       |
| `identifiers.barcode_qr` | catalog    | non-SKU identifiers (barcode / QR, incl. pack-level) are available     | Task 3.5                       |
| `branch_pricing`         | commercial | branch-level price overrides + branch availability flags are available | Task 3.8                       |
| `channel.pos`            | channel    | catalog items are offered on the POS channel                           | stored in 3a; Phase 4 / POS    |
| `channel.customer_web`   | channel    | catalog items are eligible for the Customer Web channel                | stored in 3a; Phase 7          |
| `inventory.tracked`      | inventory  | the tenant intends per-branch stock tracking                           | stored in 3a; Phase 5          |
| `inventory.lot_batch`    | inventory  | lot / batch tracking intent                                            | stored in 3a; Phase 5          |
| `inventory.expiry`       | inventory  | expiry / FEFO intent                                                   | stored in 3a; Phase 5          |
| `purchasing`             | supply     | procurement / receiving path intent                                    | stored in 3a; Phase 5          |
| `production`             | supply     | production / work-order intent                                         | stored in 3a; Phase 6          |
| `delivery`               | fulfilment | delivery-order fulfilment intent                                       | stored in 3a; Phase 7          |
| `customer_ordering`      | channel    | customer-initiated ordering (storefront / WhatsApp) intent             | stored in 3a; Phase 7          |

**16 keys.** No further key is added in Task 3.1.

### A.1 Explicitly NOT capability keys

`category_template.*`, `attribute_template.*`, `uom_template.*` are **template /
provenance concepts**, not runtime capabilities. They are **not** in this
registry and **not** stored in `tenant_catalog_capability`. The category /
attribute / UOM template _structures_ (suggested categories, attribute bundles,
UOM sets) belong to the tasks that own those domains:

| Template structure           | Owning task | Not defined in Task 3.1 |
| ---------------------------- | ----------- | ----------------------- |
| suggested category tree      | Task 3.2    | ✅                      |
| attribute-definition bundles | Task 3.3    | ✅                      |
| option-group / variant seeds | Task 3.4    | ✅                      |
| UOM sets + conversion seeds  | Task 3.6    | ✅                      |

Task 3.1 stores **only capability rows** in the template. When Task 3.2+ needs to
attach a category/attribute/UOM template to a Business Type, it adds its own
table (e.g. `business_type_template_category`) in that task — an additive
migration at that time. `business_type_template` gets **no `template_payload`
jsonb** in Task 3.1.

### A.2 Renames from the PHASE-3-PLAN.md §C.2 sketch

| PHASE-3-PLAN.md §C.2 draft key | Final key (this spec)         | Reason                                                                                                     |
| ------------------------------ | ----------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `pos_visible`                  | `channel.pos`                 | "visible" collides with a later per-product/per-variant visibility flag; this is the **tenant capability** |
| `customer_web_visible`         | `channel.customer_web`        | same — tenant capability, not a product flag                                                               |
| `lot_batch`                    | `inventory.lot_batch`         | family prefix                                                                                              |
| `expiry`                       | `inventory.expiry`            | family prefix                                                                                              |
| `production_bom`               | `strategy.bom` + `production` | the plan sketch conflated the strategy and the production intent — split                                   |
| `custom_composition`           | `strategy.custom`             | the **entitlement module** keeps the name `custom_composition`; the **capability** is `strategy.custom`    |

---

## B. The 35 Business-Type presets

Curated set, unchanged from `PHASE-3-PLAN.md` Appendix A (D0-3). **Excluded:**
Jewellery/Accessories, Mobile/Mobile-Accessories.

`FLOWER_FLORIST` · `GIFT_HAMPER` · `BAKERY_CAKE` · `CHOCOLATE_CONFECTIONERY` ·
`PERFUME_ATTAR` · `CANDLE_HOME_FRAGRANCE` · `COSMETICS_BEAUTY` ·
`HANDMADE_PRODUCTS` · `DATES_DRY_FRUITS_NUTS` · `COFFEE_TEA` ·
`SPICES_FOOD_PACKING` · `PLANT_NURSERY` · `BALLOON_PARTY_EVENT` ·
`PERSONALIZED_GIFTS` · `CORPORATE_GIFTING` · `GROCERY_MINIMART` · `SUPERMARKET` ·
`WHOLESALE_DISTRIBUTION` · `GENERAL_TRADING` · `STATIONERY_BOOKS` · `TOYS_BABY` ·
`PET_STORE` · `CLOTHING_BOUTIQUE` · `FOOTWEAR` · `COMPUTER_ELECTRONICS` ·
`HARDWARE_TOOLS` · `ELECTRICAL_PLUMBING` · `BUILDING_MATERIALS` · `AUTO_PARTS` ·
`HOME_DECOR` · `KITCHENWARE` · `PACKAGING_DISPOSABLES` · `CLEANING_SUPPLIES` ·
`MULTI_CATEGORY_RETAIL` · `CUSTOM`

Each is a **normal `business_type_template` row** (§2 — no special case). `CUSTOM`
is a row like any other; its `business_type_template_capability` set is simply the
minimal baseline (§C).

---

## C. Exact preset → capability matrix

**Every value below is a `business_type_template_capability` row with
`enabled = true`.** A capability not listed for a preset either has no row, or a
row with `enabled = false` — the apply algorithm snapshots exactly what the
template says. All values are **defaults only**: Super Admin can enable/disable
any capability for any tenant afterward regardless of preset.

### C.1 Ordinary-retail baseline (8 capabilities)

```
strategy.stocked
variants
multi_uom
identifiers.barcode_qr
branch_pricing
channel.pos
inventory.tracked
purchasing
```

Applied to every preset **except `CUSTOM`**, then extended per preset below.

### C.2 `CUSTOM` minimal template (3 capabilities)

```
strategy.stocked
branch_pricing
channel.pos
```

Nothing else. Super Admin turns on what the tenant needs.

### C.3 Per-preset resolved capability set

`baseline` = the 8 keys in C.1. `+` = added on top.

| Preset                    | Resolved enabled capabilities                                                                                                                                                                     |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FLOWER_FLORIST`          | baseline + `strategy.bom` + `strategy.custom` + `inventory.lot_batch` + `inventory.expiry` + `delivery` + `channel.customer_web` + `customer_ordering`                                            |
| `GIFT_HAMPER`             | baseline + `strategy.bom` + `strategy.custom` + `inventory.lot_batch` + `delivery` + `channel.customer_web` + `customer_ordering`                                                                 |
| `BAKERY_CAKE`             | baseline + `strategy.bom` + `strategy.custom` + `production` + `inventory.lot_batch` + `inventory.expiry` + `delivery` + `channel.customer_web` + `customer_ordering`                             |
| `CHOCOLATE_CONFECTIONERY` | baseline + `strategy.bom` + `strategy.custom` + `inventory.lot_batch` + `inventory.expiry` + `delivery` + `channel.customer_web` + `customer_ordering`                                            |
| `PERFUME_ATTAR`           | baseline + `strategy.bom` + `production` + `inventory.lot_batch` + `delivery` + `channel.customer_web` + `customer_ordering` **(owner adjustment §5)**                                            |
| `CANDLE_HOME_FRAGRANCE`   | baseline + `strategy.bom` + `production` + `delivery` + `channel.customer_web` + `customer_ordering` **(owner adjustment §5)**                                                                    |
| `COSMETICS_BEAUTY`        | baseline + `inventory.lot_batch` + `inventory.expiry` + `delivery` + `channel.customer_web` + `customer_ordering`                                                                                 |
| `HANDMADE_PRODUCTS`       | baseline + `strategy.bom` + `strategy.custom` + `production` + `delivery` + `channel.customer_web` + `customer_ordering`                                                                          |
| `DATES_DRY_FRUITS_NUTS`   | baseline + `strategy.bom` + `strategy.custom` + `inventory.lot_batch` + `inventory.expiry` + `delivery` + `channel.customer_web` + `customer_ordering`                                            |
| `COFFEE_TEA`              | baseline + `strategy.bom` + `production` + `inventory.lot_batch` + `inventory.expiry` + `delivery` + `channel.customer_web` + `customer_ordering`                                                 |
| `SPICES_FOOD_PACKING`     | baseline + `strategy.bom` + `production` + `inventory.lot_batch` + `inventory.expiry` + `delivery` + `channel.customer_web` + `customer_ordering`                                                 |
| `PLANT_NURSERY`           | baseline + `strategy.custom` + `inventory.lot_batch` + `delivery` + `channel.customer_web` + `customer_ordering` **(owner adjustment §5)**                                                        |
| `BALLOON_PARTY_EVENT`     | baseline + `strategy.bom` + `strategy.custom` + `delivery` + `channel.customer_web` + `customer_ordering`                                                                                         |
| `PERSONALIZED_GIFTS`      | baseline + `strategy.custom` + `production` + `delivery` + `channel.customer_web` + `customer_ordering`                                                                                           |
| `CORPORATE_GIFTING`       | baseline + `strategy.bom` + `strategy.custom` + `delivery` + `channel.customer_web` + `customer_ordering`                                                                                         |
| `GROCERY_MINIMART`        | baseline + `inventory.lot_batch` + `inventory.expiry` + `delivery` + `channel.customer_web` + `customer_ordering`                                                                                 |
| `SUPERMARKET`             | baseline + `inventory.lot_batch` + `inventory.expiry` + `delivery` + `channel.customer_web` + `customer_ordering`                                                                                 |
| `WHOLESALE_DISTRIBUTION`  | baseline + `inventory.lot_batch` + `delivery` _(no `channel.customer_web` / `customer_ordering` — B2B default)_                                                                                   |
| `GENERAL_TRADING`         | baseline + `delivery` + `channel.customer_web` + `customer_ordering`                                                                                                                              |
| `STATIONERY_BOOKS`        | baseline + `delivery` + `channel.customer_web` + `customer_ordering`                                                                                                                              |
| `TOYS_BABY`               | baseline + `inventory.lot_batch` + `inventory.expiry` + `delivery` + `channel.customer_web` + `customer_ordering`                                                                                 |
| `PET_STORE`               | baseline + `inventory.lot_batch` + `inventory.expiry` + `delivery` + `channel.customer_web` + `customer_ordering`                                                                                 |
| `CLOTHING_BOUTIQUE`       | baseline + `delivery` + `channel.customer_web` + `customer_ordering`                                                                                                                              |
| `FOOTWEAR`                | baseline + `delivery` + `channel.customer_web` + `customer_ordering`                                                                                                                              |
| `COMPUTER_ELECTRONICS`    | baseline + `delivery` + `channel.customer_web` + `customer_ordering`                                                                                                                              |
| `HARDWARE_TOOLS`          | baseline + `delivery` + `channel.customer_web` + `customer_ordering`                                                                                                                              |
| `ELECTRICAL_PLUMBING`     | baseline + `delivery` _(no web/ordering — trade default; heavy `multi_uom` via variant-scoped cross-family conversions in Task 3.6)_                                                              |
| `BUILDING_MATERIALS`      | baseline + `delivery` _(no web/ordering — trade default)_                                                                                                                                         |
| `AUTO_PARTS`              | baseline + `delivery` + `channel.customer_web` + `customer_ordering`                                                                                                                              |
| `HOME_DECOR`              | baseline + `delivery` + `channel.customer_web` + `customer_ordering`                                                                                                                              |
| `KITCHENWARE`             | baseline + `delivery` + `channel.customer_web` + `customer_ordering`                                                                                                                              |
| `PACKAGING_DISPOSABLES`   | baseline + `delivery` _(no web/ordering — trade default)_                                                                                                                                         |
| `CLEANING_SUPPLIES`       | baseline + `strategy.bom` + `production` + `inventory.expiry` + `delivery` + `channel.customer_web` + `customer_ordering` **(owner adjustment §5)**                                               |
| `MULTI_CATEGORY_RETAIL`   | baseline + `delivery` + `channel.customer_web` + `customer_ordering` + `inventory.lot_batch` + `inventory.expiry` **(owner adjustment §5 — deliberately NOT `strategy.bom` / `strategy.custom`)** |
| `CUSTOM`                  | `strategy.stocked` + `branch_pricing` + `channel.pos` (minimal — C.2)                                                                                                                             |

> **`MULTI_CATEGORY_RETAIL` note (owner §5):** multi-category does **not** imply
> BOM/custom by default. A tenant that genuinely needs assembled or made-to-order
> products has Super Admin enable `strategy.bom` / `strategy.custom` explicitly.

---

## D. Entitlement dependency per capability

Per owner §6: **there is no `catalog` entitlement module.** Catalog is
foundational — always available, gated only by permission + capability.
`custom_composition` is a **new** entitlement module added in Task 3.1
(as separately planned). The entitlement axis is otherwise untouched.

| Capability               | Required entitlement module               | Module status              | If entitlement absent                                                                                                   |
| ------------------------ | ----------------------------------------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `strategy.stocked`       | — (none)                                  | —                          | always usable (subject to permission)                                                                                   |
| `strategy.bom`           | `production_bom`                          | exists                     | capability row may be `enabled`, but **inert** — Task 3.2 rejects a BOM product create until the entitlement is present |
| `strategy.custom`        | `custom_composition`                      | **new in Task 3.1**        | capability row may be `enabled`, but **inert** — same as above                                                          |
| `variants`               | — (none)                                  | —                          | always usable                                                                                                           |
| `multi_uom`              | — (none)                                  | —                          | always usable                                                                                                           |
| `identifiers.barcode_qr` | — (none)                                  | —                          | always usable                                                                                                           |
| `branch_pricing`         | — (none)                                  | —                          | always usable                                                                                                           |
| `channel.pos`            | — (none)                                  | —                          | always usable                                                                                                           |
| `channel.customer_web`   | `customer_web`                            | exists                     | inert until entitled (Phase 7)                                                                                          |
| `inventory.tracked`      | — (none — basic tracking is foundational) | —                          | stored intent; Phase 5 enforces                                                                                         |
| `inventory.lot_batch`    | `advanced_inventory`                      | exists                     | inert until entitled (Phase 5)                                                                                          |
| `inventory.expiry`       | `advanced_inventory`                      | exists                     | inert until entitled (Phase 5)                                                                                          |
| `purchasing`             | — (open — see §R)                         | Phase 5 owns this decision | stored intent; Phase 5 defines the module (if any)                                                                      |
| `production`             | `production_bom`                          | exists                     | inert until entitled (Phase 6)                                                                                          |
| `delivery`               | `delivery`                                | exists                     | inert until entitled (Phase 7)                                                                                          |
| `customer_ordering`      | `customer_web`                            | exists                     | inert until entitled (Phase 7)                                                                                          |

### D.1 Enabled-but-inert consequence (owner §6 — document explicitly)

A `tenant_catalog_capability` row with `enabled = true` whose required
entitlement is **absent** is **inert**: the consuming service checks
`assertEntitled(module) ∧ assertEnabled(capability)` and fails on the entitlement
axis.

**When the tenant later gains the entitlement, the already-enabled capability
becomes usable immediately — with no edit to the capability row.** The two axes
are independent and each is evaluated live per request. Task 3.1 never writes a
capability row "off" because an entitlement is missing, and never writes one "on"
because an entitlement appeared. `HG3-1-ENTITLEMENT-INDEPENDENCE` (§P) proves
this.

---

## E. Config-JSON schema per capability

**No capability in this initial registry defines a config schema.** Every one of
the 16 keys is a plain boolean toggle in Task 3.1.

- `business_type_template_capability.config` and `tenant_catalog_capability.config`
  are **`jsonb NULL`** and are always `NULL` for Task 3.1's capabilities.
- The column exists so a future capability that genuinely needs bounded structure
  (e.g. a Phase 5 `inventory.expiry` with `{ "policy": "FEFO", "warnDays": 30 }`)
  can use it **without a migration**.
- Any capability that introduces a config shape does so **in its owning phase**.
  At that point the shape is registered in a closed
  `CATALOG_CAPABILITY_CONFIG_SCHEMAS: Partial<Record<CapabilityKey, ZodSchema>>`
  map in `packages/shared-types`, and both write paths (`PATCH` change-set,
  template apply) validate `config` against it — an unknown key or a
  schema-invalid `config` is `422`.
- Task 3.1 ships the empty map + the validation hook (so the contract is proven),
  not any actual schema.

---

## F. Normalized template schema

Two platform-global reference tables. **Both RLS-exempt** (like `country` /
`currency` / `tax_rate`); `flower_app` **SELECT-only**; writes via seed / the
`flower_platform` path.

### F.1 `business_type_template`

| Column       | Type / rule                                                                                                                                              |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `key`        | `text` **PK** — one of the 35 (§B)                                                                                                                       |
| `version`    | `int NOT NULL` — bumped on any curated edit to this template or its capability rows; a tenant records the version it snapshotted from                    |
| `name_en`    | `text NOT NULL`                                                                                                                                          |
| `name_ar`    | `text NOT NULL`                                                                                                                                          |
| `status`     | `text NOT NULL` `CHECK (status IN ('ACTIVE','DEPRECATED'))` — a `DEPRECATED` template cannot be chosen for a new tenant; existing tenants are unaffected |
| `created_at` | `timestamptz NOT NULL DEFAULT now()`                                                                                                                     |
| `updated_at` | `timestamptz NOT NULL` (`@updatedAt`)                                                                                                                    |

- No `template_payload` jsonb (owner §3). No category/attribute/UOM structure.
- Seeded: 35 rows, `version = 1`, `status = 'ACTIVE'` (except none deprecated at
  seed).

### F.2 `business_type_template_capability`

| Column           | Type / rule                                                             |
| ---------------- | ----------------------------------------------------------------------- |
| `id`             | `uuid` PK `DEFAULT uuidv7()`                                            |
| `template_key`   | `text NOT NULL` — FK → `business_type_template.key` `ON DELETE CASCADE` |
| `capability_key` | `text NOT NULL` `CHECK (capability_key IN (…16 keys…))`                 |
| `enabled`        | `boolean NOT NULL`                                                      |
| `config`         | `jsonb NULL` — always `NULL` in Task 3.1 (§E)                           |
| `created_at`     | `timestamptz NOT NULL DEFAULT now()`                                    |
| `updated_at`     | `timestamptz NOT NULL` (`@updatedAt`)                                   |

- **`UNIQUE (template_key, capability_key)`**.
- Index `(template_key)` (covered by the unique).
- Seeded from §C: each preset's resolved set → one row per capability with
  `enabled = true`; capabilities the preset does not grant get **no row** (absence
  = not granted; the apply algorithm only snapshots present rows).
- A curated edit that changes any row **must** bump the parent
  `business_type_template.version` (enforced by the seed/curation path + a seed
  test).

### F.3 `PLATFORM_GLOBAL_TABLES` / `TENANT_SCOPED_TABLES`

`packages/db/src/constants.ts`:

- `PLATFORM_GLOBAL_TABLES` += `business_type_template`, `business_type_template_capability`
- `TENANT_SCOPED_TABLES` += `tenant_catalog_capability`

The schema-baseline + RLS-coverage Testcontainers tests are extended accordingly.

---

## G. Tenant capability schema

The **only** runtime capability-state table. Tenant-scoped, `ENABLE + FORCE` RLS.

### G.1 `tenant_catalog_capability`

| Column                    | Type / rule                                                                                                          |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `id`                      | `uuid` PK `DEFAULT uuidv7()`                                                                                         |
| `tenant_id`               | `uuid NOT NULL` — FK → `tenant.id` `ON DELETE CASCADE`                                                               |
| `capability_key`          | `text NOT NULL` `CHECK (capability_key IN (…16 keys…))`                                                              |
| `enabled`                 | `boolean NOT NULL`                                                                                                   |
| `config`                  | `jsonb NULL` — always `NULL` in Task 3.1 (§E)                                                                        |
| `source_kind`             | `text NOT NULL` `CHECK (source_kind IN ('TEMPLATE','MANUAL'))` — provenance (§H)                                     |
| `source_template_key`     | `text NULL` — the template this row was snapshotted from (soft ref, not a hard FK — §H.3)                            |
| `source_template_version` | `int NULL` — the template version snapshotted                                                                        |
| `applied_at`              | `timestamptz NULL` — when the row was first written by an apply                                                      |
| `applied_by`              | `text NULL` — platform user id of the apply actor                                                                    |
| `last_changed_by`         | `text NULL` — platform user id of the most recent write (apply or `PATCH`)                                           |
| `overridden_at`           | `timestamptz NULL` — set the first time a `PATCH` changes a `TEMPLATE`-sourced row (§H)                              |
| `version`                 | `int NOT NULL DEFAULT 1` — per-row counter, reserved for a future per-row `If-Match`; not the aggregate version (§L) |
| `created_at`              | `timestamptz NOT NULL DEFAULT now()`                                                                                 |
| `updated_at`              | `timestamptz NOT NULL` (`@updatedAt`)                                                                                |

- **`UNIQUE (tenant_id, capability_key)`** — `HG3-CAPABILITY-NORMALIZATION`.
- Index `(tenant_id)`.
- **No single opaque JSON document** holds the capability set — one row per
  capability, always.
- A `PATCH` write is a **per-row upsert of only the changed keys**; every other
  row is byte-identical after the write (`updated_at` included).

### G.2 Additive columns on `tenant`

All **nullable**, forward-only (D2-12). No retype of any existing column.

| Column                          | Type                            | Purpose                                                                                                                                                                                                                                                                              |
| ------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `business_type_key`             | `text NULL`                     | FK → `business_type_template.key` `ON DELETE RESTRICT`. **Never read at runtime to branch behaviour** (D0-3 / HG3-NO-BT-BRANCH) — used only at apply time. Nullable **only** for migration compatibility with pre-Task-3.1 tenants (owner §1); the new provisioning API requires it. |
| `business_type_applied_version` | `int NULL`                      | the `business_type_template.version` the current capability set was snapshotted from                                                                                                                                                                                                 |
| `business_type_applied_at`      | `timestamptz NULL`              | when the initial apply ran                                                                                                                                                                                                                                                           |
| `catalog_capability_version`    | `int` — **pending §L approval** | the aggregate optimistic-concurrency counter for the capability set                                                                                                                                                                                                                  |

---

## H. Provenance / override semantics

Owner §16: **do not rely on `version === 1`** to decide whether a tenant
capability is still template-owned. Use an explicit model.

### H.1 `source_kind`

Every `tenant_catalog_capability` row carries `source_kind`:

| Value      | Meaning                                                                                                                                                            |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `TEMPLATE` | the row was written by an apply and **has not been changed** by a manual `PATCH` since                                                                             |
| `MANUAL`   | the row was created by a `PATCH` for a capability the template did not grant, **or** it started as `TEMPLATE` and a `PATCH` later changed its `enabled` / `config` |

### H.2 Transitions

| Event                                                              | Result                                                                                                                                                           |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| initial apply writes a row from a template capability              | `source_kind = 'TEMPLATE'`, `source_template_key` / `source_template_version` set, `applied_at` / `applied_by` set, `overridden_at = NULL`                       |
| `PATCH` changes an existing `TEMPLATE` row's `enabled` or `config` | `source_kind → 'MANUAL'`, `overridden_at = now()` (first time only), `last_changed_by = actor`; `source_template_*` **retained** (records what it diverged from) |
| `PATCH` changes an existing `MANUAL` row                           | stays `MANUAL`; `last_changed_by = actor`; `overridden_at` unchanged                                                                                             |
| `PATCH` creates a row for a capability the template never granted  | `source_kind = 'MANUAL'`, `source_template_* = NULL`, `applied_* = NULL`, `overridden_at = NULL`, `last_changed_by = actor`                                      |
| `PATCH` sets a `TEMPLATE` row to the value it already has (no-op)  | no write; `source_kind` unchanged (a true no-op does not "override")                                                                                             |

### H.3 Why `source_template_key` is a soft reference

It is `text NULL`, **not** an FK. A `DEPRECATED` template row may eventually be
pruned; a tenant's historical `source_template_key = 'BAKERY_CAKE'` must survive
that as provenance. A seed/consistency test asserts every non-null
`source_template_key` at write time corresponds to a real template; there is no
DB-level cascade.

### H.4 What Task 3.10 will use this for

Task 3.10's `merge` re-apply (§J) updates **only rows where
`source_kind = 'TEMPLATE'`** (untouched since the last apply) and leaves every
`MANUAL` row alone. The `version === 1` heuristic is never used.

---

## I. Initial template-apply algorithm

**Task 3.1 implements this and nothing else in the apply family.** It runs
**once**, during tenant provisioning, inside the existing
`provisioning.repository.ts` `runPlatform` transaction. **Generic — identical for
all 35 presets, `CUSTOM` included. No `if (key === 'CUSTOM')`, no per-key
branch.**

```
applyInitialBusinessTypeTemplate(tx, tenantId, businessTypeKey, actorPlatformUserId, now):

  # 1. resolve the template (a DB row — CUSTOM is a row like any other)
  template := tx.business_type_template.findUnique(key = businessTypeKey)
  if template is null            -> throw DomainError('UNKNOWN_BUSINESS_TYPE', 422)
  if template.status != 'ACTIVE' -> throw DomainError('BUSINESS_TYPE_NOT_ACTIVE', 422)

  # 2. read its normalized capability rows
  caps := tx.business_type_template_capability.findMany(template_key = businessTypeKey)

  # 3. snapshot every row into tenant_catalog_capability
  for cap in caps:
    tx.tenant_catalog_capability.create({
      tenant_id:               tenantId,
      capability_key:          cap.capability_key,
      enabled:                 cap.enabled,
      config:                  cap.config,
      source_kind:             'TEMPLATE',
      source_template_key:     template.key,
      source_template_version: template.version,
      applied_at:              now,
      applied_by:              actorPlatformUserId,
      last_changed_by:         actorPlatformUserId,
      overridden_at:           null,
      version:                 1,
    })

  # 4. stamp the tenant's business-type metadata
  tx.tenant.update(tenantId, {
    business_type_key:             template.key,
    business_type_applied_version: template.version,
    business_type_applied_at:      now,
    catalog_capability_version:    1,        # if §L is approved
  })

  # 5. audit (one row) — see §O
  tx.audit_log.create({
    action:      'catalog.template_applied',
    resource_type: 'business_type_template',
    resource_id:   template.key,
    tenant_id:     tenantId,
    actor_platform_user_id: actorPlatformUserId,
    reason: json({ templateKey, templateVersion, appliedCapabilityKeys: caps.map(c => c.capability_key) }),
  })
```

### I.1 Provisioning integration

- `ProvisionTenantCommand` / the `POST /v1/platform/tenants` body gain
  **`businessTypeKey: string` (required)** — owner §1. Validation:
  - missing / empty → `422 BUSINESS_TYPE_REQUIRED` (the API never picks a default)
  - not a known `ACTIVE` template → `422 UNKNOWN_BUSINESS_TYPE` /
    `422 BUSINESS_TYPE_NOT_ACTIVE`
- The apply step runs **after** entitlement / limit / role seeding, **inside the
  same transaction**. A failure rolls back the whole provision (no partial
  capability rows).
- **Idempotency:** the existing `idem:provision:<key>` Redis guard replays the
  entire response; a retried provision is a full no-op.
- **Pre-Task-3.1 tenants:** unaffected. `tenant.business_type_key` stays `NULL`;
  they have zero `tenant_catalog_capability` rows until a deliberate backfill
  (a separate, later, explicitly-approved operation — not Task 3.1).

### I.2 Behaviour of a tenant with no capabilities (pre-3.1 or un-backfilled)

Catalog-create endpoints (Task 3.2+) call `assertEnabled(...)` and therefore
**reject every product create** for such a tenant until its capabilities are
configured — a safe closed default. Task 3.1 itself has no create endpoint, so it
is unaffected.

---

## J. Future re-apply merge / replace contract (Task 3.10)

**Not implemented in Task 3.1.** Locked here so Task 3.10 has no ambiguity and so
§H's provenance columns are designed correctly now.

Route (Task 3.10): `POST /v1/platform/tenants/:tenantId/apply-business-type-template`
— `platform:catalog_capability:manage` + step-up + `Idempotency-Key`
(`catalog.template.apply`). Body: `{ templateKey, mode: 'merge' | 'replace' }`.

| Mode              | Semantics                                                                                                                                                                                                                                                                                                                                                    |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `merge` (default) | For each capability in the target template: upsert the `(tenant_id, capability_key)` row **only if it is `source_kind = 'TEMPLATE'`** (untouched since the last apply). A `MANUAL` row is **left exactly as-is**. Capabilities not in the template are **not touched**. Nothing is ever deleted or disabled implicitly.                                      |
| `replace`         | For each capability in the target template: **overwrite** the row's `enabled` / `config` to the template's value **regardless of `source_kind`**, and set `source_kind = 'TEMPLATE'`, `source_template_version = <new>`, `overridden_at = NULL`. Capabilities **not** in the template — including tenant-specific `MANUAL` keys — are **still not deleted**. |

Both modes: bump `business_type_template_applied_version` + `catalog_capability_version`,
write one `catalog.template_applied` audit row capturing
`{ mode, fromVersion, toVersion, changedCapabilityKeys }`, and run in one
transaction. Neither mode is a destructive wipe.

---

## K. API DTOs

All routes `/v1/...`, `camelCase` wire, the standard error envelope, the existing
guard pipeline, `@RequirePermission(...)` on every route (CLAUDE.md rule 9).

### K.1 `GET /v1/platform/business-type-templates`

- **Realm/permission:** platform · `platform:tenants:view`
- **Concurrency:** none (read)

```jsonc
// 200
{
  "data": [
    {
      "key": "BAKERY_CAKE",
      "version": 1,
      "nameEn": "Bakery & Cake Shop",
      "nameAr": "…",
      "status": "ACTIVE",
      "capabilities": [
        {
          "capabilityKey": "strategy.stocked",
          "enabled": true,
          "config": null,
        },
        { "capabilityKey": "strategy.bom", "enabled": true, "config": null },
        // …
      ],
    },
    // … 35 rows
  ],
}
```

### K.2 `GET /v1/platform/tenants/:tenantId/catalog-capabilities`

- **Realm/permission:** platform · `platform:catalog_capability:manage`
  _(read of the surface a step-up write will modify; no step-up on the read)_
- **Concurrency:** returns the aggregate version (§L) as `ETag` + body

```jsonc
// 200
{
  "tenantId": "01J…",
  "businessTypeKey": "BAKERY_CAKE",
  "businessTypeAppliedVersion": 1,
  "businessTypeAppliedAt": "2026-09-06T09:00:00.000Z",
  "aggregateVersion": 3, // == tenant.catalog_capability_version
  "capabilities": [
    {
      "capabilityKey": "strategy.bom",
      "enabled": true,
      "config": null,
      "sourceKind": "TEMPLATE",
      "sourceTemplateKey": "BAKERY_CAKE",
      "sourceTemplateVersion": 1,
      "overriddenAt": null,
      "requiredEntitlement": "production_bom",
      "inert": false, // true iff requiredEntitlement present AND not entitled
    },
    // …
  ],
}
```

`ETag: "3"` header mirrors `aggregateVersion`.

### K.3 `PATCH /v1/platform/tenants/:tenantId/catalog-capabilities`

- **Realm/permission:** platform · `platform:catalog_capability:manage` **+ step-up**
- **Concurrency:** **`If-Match: "<aggregateVersion>"` required** → `409 CATALOG_CAPABILITY_VERSION_CONFLICT` on mismatch (§L)
- **Idempotency:** `Idempotency-Key` **not** required — the operation is a
  version-guarded state transition, not a command with external side effects
  (D2-9). _(Open item R-4: add an optional `Idempotency-Key` anyway? Recommend
  no.)_
- **No `applyTemplateKey`, no `mode`** — those are Task 3.10 only (owner §9).

```jsonc
// request
// If-Match: "3"
{
  "changes": [
    { "capabilityKey": "multi_uom", "enabled": true, "config": null },
    { "capabilityKey": "delivery", "enabled": false, "config": null },
  ],
  "reason": "tenant onboarding — enable weight-based UOM", // optional; required-where-audit-conventions-require
}
```

- `changes` is a **non-empty** array; each entry names one capability.
  `capabilityKey` must be in the closed registry (else `422 UNKNOWN_CAPABILITY_KEY`);
  `config` must satisfy that key's schema if it has one (else `422`); duplicate
  `capabilityKey` in one request → `422`.
- Each change is a **per-row upsert**: create (`source_kind = 'MANUAL'`) or update
  (`source_kind → 'MANUAL'`, `overridden_at` first-time). Rows not named are
  **untouched** (byte-identical).
- A change whose `enabled` + `config` already match the stored row is a **no-op**
  for that row (no write, no `source_kind` change) but the request still succeeds
  and still bumps the aggregate version if any _other_ change wrote.
- On success: bump `tenant.catalog_capability_version`, one
  `tenant.catalog_capability_changed` audit row (§O), return the full new state
  (same shape as K.2) + the new `ETag`.

```jsonc
// 200 — same body shape as K.2, with aggregateVersion incremented
```

### K.4 `GET /v1/catalog/capabilities`

- **Realm/permission:** tenant · `catalog:view`
- **Scope:** tenant (from session) — the caller's own tenant only
- **Concurrency:** none (read)

```jsonc
// 200
{
  "businessTypeKey": "BAKERY_CAKE",
  "capabilities": [
    { "capabilityKey": "strategy.bom", "enabled": true, "inert": false },
    { "capabilityKey": "delivery", "enabled": true, "inert": true }, // entitlement absent
    // …
  ],
}
```

The tenant read is **deliberately thinner** than the platform read — no
provenance, no template versions, no actor ids. It exists so the Owner UI can
hide inert modules.

### K.5 Provisioning body delta

`POST /v1/platform/tenants` request gains **`businessTypeKey: string` (required)**.
`packages/api-client` `ProvisionTenantInput` extended. No other provisioning field
changes.

---

## L. Optimistic-concurrency proposal

**Proposed for approval before any code (owner §10).**

### L.1 The aggregate

The **tenant's catalog-capability set** is one aggregate. A `PATCH` with N
`changes` is a single atomic transition of that aggregate. Concurrency control
belongs at the aggregate boundary, not per row.

### L.2 Recommended mechanism — a single tenant-level counter

Add **`tenant.catalog_capability_version int NOT NULL DEFAULT 0`** (additive
column, owner §17).

| Step                           | Behaviour                                                                                                                                                                                                                                 |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| provisioning initial apply     | sets it to `1`                                                                                                                                                                                                                            |
| `GET …/catalog-capabilities`   | returns it as `aggregateVersion` + `ETag: "<n>"`                                                                                                                                                                                          |
| `PATCH …/catalog-capabilities` | **requires** `If-Match: "<n>"`; if `n != current` → `409 CATALOG_CAPABILITY_VERSION_CONFLICT`; on success, `UPDATE tenant SET catalog_capability_version = catalog_capability_version + 1` **in the same transaction** as the row upserts |
| Task 3.10 re-apply             | bumps it too                                                                                                                                                                                                                              |

- **Migration note:** `int NOT NULL DEFAULT 0` on `tenant` is a metadata-only
  change on PostgreSQL 11+ (constant default, no table rewrite) — safe and fast
  even though `tenant` has rows. If the owner prefers strict "nullable-additive
  first" (D2-12), the alternative is `int NULL` with the app treating `NULL` as
  `0`; the recommended form is `NOT NULL DEFAULT 0` for a cleaner invariant.
- Existing (pre-3.1) tenants get `0`; their first `PATCH` uses `If-Match: "0"`.

### L.3 Alternatives considered and rejected

| Alternative                                                                                  | Rejected because                                                                                                                                                                                                                                                                                              |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Per-row `tenant_catalog_capability.version` + one `If-Match` per changed key                 | A `PATCH` touching 5 rows needs 5 `If-Match` values; the audit + client-retry story is messy; concurrent disjoint edits give a false sense of safety. The per-row `version` column is still kept (reserved) for a possible future single-row edit route, but it is **not** the `PATCH` concurrency mechanism. |
| No column — ETag = hash of the sorted `(capability_key, enabled, config, updated_at)` tuples | Works, but an opaque hash is harder to reason about in logs/audit and in the SA UI than a monotonic integer; recompute cost grows with the row count.                                                                                                                                                         |
| No column — ETag = `max(updated_at)` epoch-ms                                                | Not monotonic-safe under clock skew / same-ms writes.                                                                                                                                                                                                                                                         |

### L.4 If §L is not approved

Task 3.1's `PATCH` would fall back to **no `If-Match`** (last-write-wins per row,
each row still an isolated upsert). Not recommended — a two-admin race could
silently clobber. The spec recommends approving L.2.

---

## M. Super Admin UI contract

**In scope for Task 3.1** (owner §11). Minimal, usable. **No** Product / Category
/ Attribute / Variant / UOM / Pricing / Identifier / Tax UI.

### M.1 Provisioning form

- Add a **required** "Business Type" `<select>` to the "Provision a tenant" form
  in `apps/super-admin-web`.
- Options: the 35 template keys (label = `nameEn`), sorted, **no blank / default
  option** — the form cannot submit without an explicit choice. `CUSTOM` is a
  normal option in the list (label e.g. "Custom / other").
- Wired through `packages/api-client` `ProvisionTenantInput.businessTypeKey`.
- The e2e seed (`apps/super-admin-web/e2e/seed.mjs`) + smoke spec updated to
  supply the field and seed the templates.

### M.2 Tenant detail → "Catalog / Business Capabilities" section

**Read (any SA with `platform:tenants:view`):**

- Selected Business Type (`businessTypeKey` + `nameEn`).
- Applied template version + `businessTypeAppliedAt`.
- The capability list: each row shows `capabilityKey`, a human label, `enabled`
  toggle state, `sourceKind` (`TEMPLATE` / `MANUAL` badge), and — for
  entitlement-backed capabilities whose entitlement is **absent** — an
  **"Inert — requires <entitlement>"** badge.

**Write (SA with `platform:catalog_capability:manage` + fresh step-up):**

- Toggle an individual capability row on/off. Each toggle issues a `PATCH` with a
  single `changes` entry and the current `If-Match`.
- On `409` (another admin changed the set): re-fetch, show a "changed elsewhere —
  review and retry" notice, re-apply.
- The step-up challenge follows the existing platform step-up flow (same as
  `platform:entitlements:manage`).

### M.3 Not built in Task 3.1

- Bulk capability editing / template re-apply UI (Task 3.10).
- Any catalog data screen.
- A tenant-facing (Owner Web) capability screen — the `GET /v1/catalog/capabilities`
  API exists; the Owner Web consumer is a later task.

---

## N. RLS / privilege matrix

### N.1 Table-by-table

| Table                               | List membership                   | RLS                                                                                                                                   | `flower_app`                                                                                                | `flower_platform`                                   | `flower_migrate` |
| ----------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | ---------------- |
| `business_type_template`            | `PLATFORM_GLOBAL_TABLES`          | **exempt** (reference data)                                                                                                           | **SELECT only** — `REVOKE INSERT, UPDATE, DELETE`                                                           | full DML (seed / curation)                          | DDL              |
| `business_type_template_capability` | `PLATFORM_GLOBAL_TABLES`          | **exempt**                                                                                                                            | **SELECT only** — `REVOKE INSERT, UPDATE, DELETE`                                                           | full DML                                            | DDL              |
| `tenant_catalog_capability`         | `TENANT_SCOPED_TABLES`            | **`ENABLE` + `FORCE`**, policy `USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)` + matching `WITH CHECK` | **SELECT only** — `REVOKE INSERT, UPDATE, DELETE` (owner §7); the Owner read is a scoped `SELECT` under RLS | write path — via `runPlatform` (BYPASSRLS, audited) | DDL              |
| `tenant` (+4 columns)               | `TENANT_SCOPED_TABLES` (existing) | existing `tenant_isolation` policy (keys on `id`)                                                                                     | existing grants; the new columns are readable; `business_type_*` are written only via the platform path     | write                                               | DDL              |

### N.2 Migration grant/revoke steps (explicit — the Phase 1 `ALTER DEFAULT PRIVILEGES` auto-grants `flower_app` full DML on new tables)

```sql
-- after CREATE TABLE for the three new tables:
REVOKE INSERT, UPDATE, DELETE ON
  "business_type_template", "business_type_template_capability", "tenant_catalog_capability"
  FROM flower_app;
-- SELECT stays (resolution + the Owner read path need it).

-- RLS only on the tenant-owned one:
ALTER TABLE "tenant_catalog_capability" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenant_catalog_capability" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_catalog_capability_isolation" ON "tenant_catalog_capability"
  USING ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);
```

### N.3 No-GUC behaviour

- `tenant_catalog_capability`: a query with `app.tenant_id` unset returns **zero
  rows** (`HG3-RLS`).
- `business_type_template` / `_capability`: readable with no GUC (reference data,
  not secret) — but **not writable** by `flower_app` at the DB level.
- `flower_app` stays `NOSUPERUSER NOBYPASSRLS`. **No new DB role** (owner §7).

---

## O. Audit actions

Two **new** keys in `apps/api/src/common/audit/actions.ts` `AUDITABLE_ACTIONS`,
written via the existing `AuditWriter` **inside the write transaction** (D2-10 —
no second audit system).

| Key                                 | `resourceType`              | `security` | Emitted by                                                      |
| ----------------------------------- | --------------------------- | ---------- | --------------------------------------------------------------- |
| `catalog.template_applied`          | `business_type_template`    | **true**   | the initial provisioning apply (§I); (later) Task 3.10 re-apply |
| `tenant.catalog_capability_changed` | `tenant_catalog_capability` | **true**   | every `PATCH …/catalog-capabilities`                            |

### O.1 Record contents

**`catalog.template_applied`** (initial apply):

```jsonc
{
  "action": "catalog.template_applied",
  "resourceType": "business_type_template",
  "resourceId": "BAKERY_CAKE",
  "tenantId": "01J…",
  "actorPlatformUserId": "01J…",
  "reason": {
    "templateKey": "BAKERY_CAKE",
    "templateVersion": 1,
    "appliedCapabilityKeys": ["strategy.stocked", "strategy.bom", "…"],
  },
}
```

**`tenant.catalog_capability_changed`** (manual `PATCH`) — records, at minimum
(owner §13): tenant, actor, changed capability keys, **before/after `enabled`
state per key**, timestamp, and `reason` (from the request body where present):

```jsonc
{
  "action": "tenant.catalog_capability_changed",
  "resourceType": "tenant_catalog_capability",
  "resourceId": "01J…", // the tenant id (the aggregate)
  "tenantId": "01J…",
  "actorPlatformUserId": "01J…",
  "reason": {
    "reason": "tenant onboarding — enable weight-based UOM",
    "aggregateVersionFrom": 3,
    "aggregateVersionTo": 4,
    "changes": [
      { "capabilityKey": "multi_uom", "enabledFrom": false, "enabledTo": true },
      { "capabilityKey": "delivery", "enabledFrom": true, "enabledTo": false },
    ],
  },
}
```

### O.2 `SECURITY_ACTION_PREFIXES`

`tenant.` already covers `tenant.catalog_capability_changed`. Add **`catalog.`**
for `catalog.template_applied`. `actions.test.ts` keeps the `security_event` view
`LIKE` patterns in sync with the `security: true` entries.

---

## P. Hard gates / tests

### P.1 Hard gates (build-blocking on the Task 3.1 PR)

| Gate                             | Assertion                                                                                                                                                                                                                                                                                                                   |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `HG3-CAPABILITY-NORMALIZATION`   | `UNIQUE (tenant_id, capability_key)` + `UNIQUE (template_key, capability_key)`; a `PATCH` of one key leaves every other row byte-identical; no single-blob storage                                                                                                                                                          |
| `HG3-TEMPLATE-SNAPSHOT`          | an edit to `business_type_template` / `_capability` (bump `version`, change a row) does **not** mutate any already-applied tenant's `tenant_catalog_capability` rows; the tenant's `source_template_version` still records the version it snapshotted                                                                       |
| `HG3-1-PROVENANCE`               | `source_kind` transitions per §H (apply → `TEMPLATE`; first `PATCH` change → `MANUAL` + `overridden_at`; template-never-granted key via `PATCH` → `MANUAL`, null `source_template_*`); no reliance on `version === 1`                                                                                                       |
| `HG3-1-GENERIC-APPLY`            | the provisioning apply has **no per-template branch** — a repo scan for `=== 'CUSTOM'` / a `switch` on `businessTypeKey` in the apply path fails the gate; `CUSTOM` provisions through the identical code path as `BAKERY_CAKE` (a test provisions both and diffs the code path)                                            |
| `HG3-1-BUSINESS-TYPE-REQUIRED`   | `POST /v1/platform/tenants` with no `businessTypeKey` → `422 BUSINESS_TYPE_REQUIRED`; with an unknown/deprecated key → `422`; the API never substitutes a default                                                                                                                                                           |
| `HG3-NO-BT-BRANCH`               | no code path reads `tenant.business_type_key` to branch runtime behaviour — repo scan (`business_?type`) outside the apply/provisioning code + review; the capability service reads only `tenant_catalog_capability`                                                                                                        |
| `HG3-1-ENTITLEMENT-INDEPENDENCE` | a template apply does **not** write `tenant_entitlement`; an `enabled` capability whose entitlement is absent is inert; granting the entitlement later makes it usable with **no** capability-row write (a test toggles the entitlement and re-checks `assertEnabled ∧ assertEntitled` without touching the capability row) |
| `HG3-PERMISSION-STABILITY`       | only `platform:catalog_capability:manage` is added; `identifiers:manage` unchanged and appears exactly once; `@flower/permissions` key-registry test + probe meta-test green                                                                                                                                                |
| `HG3-RLS`                        | `tenant_catalog_capability` `ENABLE + FORCE` + policy; no-GUC scoped query → 0 rows; `WITH CHECK` blocks a foreign-`tenant_id` insert; `business_type_template*` RLS-exempt, `flower_app` SELECT-only (INSERT/UPDATE/DELETE denied at the DB); `flower_app` still `NOBYPASSRLS`; **no new DB role**                         |
| `HG3-1-CONCURRENCY`              | (if §L approved) `PATCH` without `If-Match` → `428`/`400`; stale `If-Match` → `409 CATALOG_CAPABILITY_VERSION_CONFLICT`; a successful `PATCH` bumps `tenant.catalog_capability_version` in the same txn                                                                                                                     |
| `HG3-TENANT-ISOLATION`           | the cross-tenant probe suite is extended to all four new endpoints — tenant B cannot read/write tenant A's capabilities by id / param / URL → 403/404/0 rows; mutation-tested                                                                                                                                               |
| `HG3-IDEM`                       | provisioning replay (same idempotency key) is a full no-op — no duplicate capability rows                                                                                                                                                                                                                                   |
| `HG3-AUDIT`                      | `catalog.template_applied` + `tenant.catalog_capability_changed` registered in `AUDITABLE_ACTIONS`; `actions.test.ts` (closed set) green; the apply writes exactly one row; a `PATCH` writes exactly one row with the before/after detail of §O.1                                                                           |
| `HG3-NO-PREMATURE-DOMAIN`        | no `category` / `product` / `product_type` / `attribute*` / `variant*` / `item_identifier` / `uom*` / price / inventory / order table or service; boundary lint + review                                                                                                                                                    |
| `HG3-1-NO-REALTIME`              | no `outbox` write, no new realtime topic/channel, no gateway change in the Task 3.1 diff                                                                                                                                                                                                                                    |
| `HG3-REGRESSION`                 | full Phase 0–2-core `turbo run test` green after Task 3.1 (api · worker · realtime · scheduler · db · backend · spike-rls · money · uom)                                                                                                                                                                                    |
| `HG3-CI`                         | GitHub CI `verify` + `security` + `e2e` + `realtime` green on the PR HEAD; cumulative `security-review` (`phase-2-core-complete` → HEAD) no open Critical/High                                                                                                                                                              |

### P.2 Tests

**Unit**

- `CapabilityKey` closed-set: every registry key round-trips; an unknown key is
  rejected by the type guard + the zod schema.
- capability-check service truth table: `enabled` row → `true`; `enabled = false`
  row → `false`; missing row → `false`; `assertEnabled` throws the
  config/domain error (not 401/403) when disabled.
- provenance transition table (§H.2) as a pure function over row state.
- `PATCH` change-set resolver: per-row upsert; no-op detection; duplicate key →
  `422`; unknown key → `422`.
- entitlement-independence: `assertEnabled` does not consult `tenant_entitlement`;
  the consuming-service pattern `assertEntitled ∧ assertEnabled` is unit-tested
  with a fake.

**Integration (Testcontainers — Postgres)**

- migration baseline: the three tables exist with the documented columns /
  constraints / indexes; `TENANT_SCOPED_TABLES` / `PLATFORM_GLOBAL_TABLES` match
  the DB; the RLS-coverage test passes.
- RLS: `tenant_catalog_capability` `ENABLE + FORCE`; no-GUC → 0 rows;
  `WITH CHECK` blocks a foreign insert; tenant B cannot see tenant A's rows.
- platform privilege: `flower_app` cannot `INSERT` / `UPDATE` / `DELETE` any of
  the three tables; `flower_platform` can; `business_type_template*` readable
  with no GUC.
- generic apply: provision a `BAKERY_CAKE` tenant → the exact §C.3 capability set
  with `source_kind = 'TEMPLATE'`, `source_template_version = 1`, `applied_*`
  set; provision a `CUSTOM` tenant → the 3-key minimal set through the identical
  code path; provision with no `businessTypeKey` → `422`.
- template-snapshot: apply `BAKERY_CAKE` v1 → bump the template to v2 (add a
  capability row, `version = 2`) → the already-provisioned tenant's rows are
  byte-identical; `business_type_applied_version` still `1`.
- `PATCH`: enable `multi_uom` → row becomes `MANUAL`, `overridden_at` set,
  aggregate version `1 → 2`, one audit row with before/after; a second `PATCH`
  with the stale `If-Match` → `409`; a `PATCH` that only sets an already-true
  value → success, no write, no version bump.
- tenant read: `GET /v1/catalog/capabilities` returns only the caller's tenant;
  `inert` is `true` for `delivery` when the `delivery` entitlement is off and
  flips to `false` when it is granted — **with no capability-row write**.
- cross-tenant probe suite extended to the four endpoints.
- provisioning idempotency: a replayed provision produces no duplicate rows.

**Regression**

- full Phase 0–2-core suite green.

---

## Q. Explicit non-scope

Task 3.1 creates **no** table, model, migration, API, service, DTO, or UI for:

- Category · Product · Product Type · Attribute definition / option / value ·
  Option group / option value · Variant · Variant option value · Identifier
  (`item_identifier`) · UOM DB config (`uom`, `uom_conversion`,
  `variant.base_uom_code`).
- Company per-UOM pricing (`company_variant_uom_price`) · branch price override /
  availability (`branch_variant_uom_price`, `branch_variant_availability`).
- Tax category on the catalog · `TaxResolutionService`.
- Inventory / stock / movement / reservation / balance / lot / expiry
  **enforcement** (the capability _toggles_ are stored; nothing reads them in 3a).
- Orders · payments · receivables · accounting / GL · POS sale · anything Phase 3b.

Also **not** in Task 3.1:

- **Template re-apply** (`POST …/apply-business-type-template`, `merge` / `replace`)
  — Task 3.10 (owner §9). The contract is locked in §J; no code.
- **Category / attribute / UOM template structures** on `business_type_template`
  — each belongs to its owning task (3.2 / 3.3 / 3.6) as an additive migration
  then (§A.1).
- **Catalog realtime events** — Task 3.10 (owner §14). No `outbox`/realtime change.
- **A `catalog` entitlement module** — catalog is foundational; not added (owner §6).
- **Product-create capability _enforcement_** — Task 3.2 (the service calls the
  Task 3.1 helper).
- **A bulk-edit / template-management SA screen** and **any Owner Web capability
  screen** — later tasks.
- **A backfill of pre-3.1 tenants** — a separate, explicitly-approved operation.

---

## R. Open items for owner sign-off

| #       | Item                                                                                                                                                                                                                                                              | Recommendation                                                                                                                   |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| **R-1** | The 16-key closed capability registry (§A)                                                                                                                                                                                                                        | Approve as written                                                                                                               |
| **R-2** | The per-preset capability matrix (§C.3), incl. the 5 owner adjustments and the B2B/trade presets defaulting `channel.customer_web` / `customer_ordering` **off** (`WHOLESALE_DISTRIBUTION`, `ELECTRICAL_PLUMBING`, `BUILDING_MATERIALS`, `PACKAGING_DISPOSABLES`) | Approve, or send deltas                                                                                                          |
| **R-3** | **§L** — add `tenant.catalog_capability_version int NOT NULL DEFAULT 0` as the aggregate optimistic-concurrency counter; `PATCH` requires `If-Match`; `409` on mismatch                                                                                           | **Approve L.2** (the recommended mechanism)                                                                                      |
| **R-4** | `PATCH …/catalog-capabilities` — add an optional `Idempotency-Key` in addition to `If-Match`?                                                                                                                                                                     | **No** — `If-Match` is sufficient for a version-guarded state transition with no external side effect (D2-9)                     |
| **R-5** | `purchasing` capability — entitlement mapping (§D)                                                                                                                                                                                                                | Leave **unmapped** in Task 3.1 (foundational intent); Phase 5 decides whether a `procurement` module is introduced               |
| **R-6** | `inventory.tracked` — entitlement mapping                                                                                                                                                                                                                         | Leave **unmapped** (basic per-branch tracking is foundational; `advanced_inventory` gates lot/batch/expiry only)                 |
| **R-7** | `GET /v1/platform/tenants/:tenantId/catalog-capabilities` permission — `platform:catalog_capability:manage` (no step-up on read) vs a lighter `platform:tenants:view`                                                                                             | Use **`platform:catalog_capability:manage`** for the read too (it is the surface the write mutates); step-up only on the `PATCH` |
| **R-8** | `tenant.catalog_capability_version` column form — `NOT NULL DEFAULT 0` (recommended, PG11+ fast) vs `NULL` treated as `0`                                                                                                                                         | `NOT NULL DEFAULT 0`                                                                                                             |
| **R-9** | Config-schema map (§E) — ship the empty `CATALOG_CAPABILITY_CONFIG_SCHEMAS` + validation hook now, or defer entirely to the first phase that needs a schema                                                                                                       | Ship the **empty map + hook** now (proves the contract; zero schemas)                                                            |

---

## S. Expected Task 3.1 migration (after this spec is approved — for reference only)

Additive, forward-only. **No `schema.prisma` change or migration is produced by
this document.**

```
new tables:
  business_type_template              (platform-global, RLS-exempt)
  business_type_template_capability    (platform-global, RLS-exempt)
  tenant_catalog_capability            (tenant-owned, RLS ENABLE + FORCE)

existing table `tenant` — additive nullable / defaulted columns only:
  business_type_key             text NULL         FK -> business_type_template.key ON DELETE RESTRICT
  business_type_applied_version  int  NULL
  business_type_applied_at       timestamptz NULL
  catalog_capability_version      int  NOT NULL DEFAULT 0     (pending R-3 / R-8)

grants:
  REVOKE INSERT, UPDATE, DELETE on the three new tables FROM flower_app  (SELECT retained)

RLS:
  ENABLE + FORCE + tenant policy on tenant_catalog_capability only

seed:
  35 business_type_template rows (version 1, ACTIVE)
  business_type_template_capability rows per §C.3
  entitlement_default rows for the new `custom_composition` module

NOT in this migration:
  any Product / Category / Product Type / Attribute / Variant / Option / Identifier
  / UOM / Pricing / Tax / Inventory / Order table.
```

Migration-baseline Testcontainers tests are mandatory (D2-12); the migration-order
test's `.at(-1)` assertion updates to the new migration name.

---

_End of PHASE-3.1-CAPABILITY-SPEC.md. Documentation only — awaiting owner approval
of the capability spec before any Task 3.1 schema, migration, or runtime code._
