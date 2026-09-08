import { z } from 'zod';
// the authoritative Money DTO validator lives with the value object (it needs the
// currency table); imported here so task-3.7 schemas below can compose it, and
// re-exported (line below) as the shared FE/BE surface.
import { moneyDtoSchema, type MoneyDtoShape as MoneyDto } from '@flower/money';

/**
 * Contracts shared FE/BE. No business logic lives here (ADR-0001).
 * This is the Phase 0 seed — DTOs are added per phase.
 */

// --- branded id types (UUID v7 — DB-CONVENTIONS) ---
export type TenantId = string & { readonly __brand: 'TenantId' };
export type BranchId = string & { readonly __brand: 'BranchId' };
export type CompanyId = string & { readonly __brand: 'CompanyId' };

export const uuidSchema = z.uuid();

// --- Money / Quantity DTOs — the authoritative, currency/range-aware validators
//     live with the value objects (they need the currency table / the
//     NUMERIC(18,4) bounds); re-exported here as the shared FE/BE import surface. ---
export { moneyDtoSchema, type MoneyDto };
export { type MoneyDTO } from '@flower/money';
export {
  quantityDtoSchema,
  type QuantityDtoShape as QuantityDto,
  type QuantityDTO,
  // Phase 3 task 3.6 — canonical UOM-code semantics + the built-in registry live
  // in the authoritative UOM package; re-exported here as the shared FE/BE surface.
  BUILTIN_UOMS,
  UOM_CODE_RE,
  canonicalUomCode,
  isBuiltinUom,
  type UomDef,
  type UomFamily,
} from '@flower/uom';

// --- API error envelope (API-CONVENTIONS) ---
export const apiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.array(z.object({ field: z.string().optional(), issue: z.string() })).optional(),
    correlationId: z.string().optional(),
  }),
});
export type ApiError = z.infer<typeof apiErrorSchema>;

// --- feature entitlements & plan limits (ARCHITECTURE §48) ---

/**
 * Feature modules a plan can switch on/off. A permission whose module is not
 * entitled is inert (checked at runtime). None of these are implemented in
 * Phase 1 — the list exists so plans/entitlements can be modelled now.
 */
export const ENTITLEMENT_MODULES = [
  'customer_web',
  'ai_whatsapp',
  'customer_web_ai',
  'advanced_inventory',
  'production_bom',
  'biometric_attendance',
  'biometric_face',
  'biometric_fingerprint',
  'biometric_rfid',
  'advanced_reporting',
  'delivery',
  // Phase 3 task 3.1 — the made-to-order / composed-at-sale module referenced by
  // the `strategy.custom` catalog capability (spec §D). There is deliberately NO
  // generic `catalog` entitlement module — catalog is foundational (owner §6).
  'custom_composition',
] as const;
export type EntitlementModule = (typeof ENTITLEMENT_MODULES)[number];
export const entitlementModuleSchema = z.enum(ENTITLEMENT_MODULES);

// --- catalog capabilities (Phase 3 task 3.1) — docs/phase-3/PHASE-3.1-CAPABILITY-SPEC.md §A ---

/**
 * The closed catalog-capability-key registry. A capability key is a real runtime
 * toggle a catalog / inventory / channel service reads to decide whether a
 * behaviour is available for a tenant. It is NOT a template payload and NOT a
 * provenance concept — `category_template.*` / `attribute_template.*` /
 * `uom_template.*` are deliberately excluded (those template structures belong
 * to Tasks 3.2 / 3.3 / 3.6). Mirrored by the DB CHECK constraints on
 * `business_type_template_capability` and `tenant_catalog_capability` — kept in
 * sync by a test.
 */
export const CATALOG_CAPABILITY_KEYS = [
  'strategy.stocked',
  'strategy.bom',
  'strategy.custom',
  'variants',
  'multi_uom',
  'identifiers.barcode_qr',
  'branch_pricing',
  'channel.pos',
  'channel.customer_web',
  'inventory.tracked',
  'inventory.lot_batch',
  'inventory.expiry',
  'purchasing',
  'production',
  'delivery',
  'customer_ordering',
] as const;
export type CapabilityKey = (typeof CATALOG_CAPABILITY_KEYS)[number];
export const capabilityKeySchema = z.enum(CATALOG_CAPABILITY_KEYS);
export function isCapabilityKey(value: string): value is CapabilityKey {
  return (CATALOG_CAPABILITY_KEYS as readonly string[]).includes(value);
}

/**
 * Per-capability `config` JSON-shape registry. **Empty in Task 3.1 (spec §E)** —
 * every one of the 16 keys is a plain boolean toggle with `config = null`. The
 * map is typed so a later phase can register a bounded schema for one capability
 * deliberately (in its own PR), with no migration. A write that supplies a
 * non-null `config` for a key with NO registered schema is rejected — never
 * silently persisted as arbitrary JSON.
 */
export const CATALOG_CAPABILITY_CONFIG_SCHEMAS: Partial<Record<CapabilityKey, z.ZodType>> = {};

export type CapabilityConfigCheck =
  | { ok: true }
  | {
      ok: false;
      code: 'CAPABILITY_CONFIG_NOT_SUPPORTED' | 'CAPABILITY_CONFIG_INVALID';
      message: string;
    };

/**
 * Validate a capability `config` value against the registry. `null` / `undefined`
 * is always OK. A non-null value for a key with no registered schema is
 * `CAPABILITY_CONFIG_NOT_SUPPORTED`; a value that fails a registered schema is
 * `CAPABILITY_CONFIG_INVALID`.
 */
export function checkCapabilityConfig(key: CapabilityKey, config: unknown): CapabilityConfigCheck {
  if (config === null || config === undefined) return { ok: true };
  const schema = CATALOG_CAPABILITY_CONFIG_SCHEMAS[key];
  if (!schema) {
    return {
      ok: false,
      code: 'CAPABILITY_CONFIG_NOT_SUPPORTED',
      message: `capability "${key}" does not accept a config value`,
    };
  }
  const parsed = schema.safeParse(config);
  return parsed.success
    ? { ok: true }
    : { ok: false, code: 'CAPABILITY_CONFIG_INVALID', message: parsed.error.message };
}

/**
 * Which billing entitlement module a capability depends on to be USABLE (spec
 * §D). A capability row may be `enabled` while its entitlement is absent — it is
 * then INERT: the consuming service checks `assertEntitled ∧ assertEnabled`, and
 * gaining the entitlement later makes it usable with NO capability-row write.
 * A key not in this map is always usable (subject to permission). Task 3.1
 * enforces none of this — it only exposes `inert` on the capability read (§K).
 */
export const CAPABILITY_REQUIRED_ENTITLEMENT: Partial<Record<CapabilityKey, EntitlementModule>> = {
  'strategy.bom': 'production_bom',
  'strategy.custom': 'custom_composition',
  'channel.customer_web': 'customer_web',
  'inventory.lot_batch': 'advanced_inventory',
  'inventory.expiry': 'advanced_inventory',
  production: 'production_bom',
  delivery: 'delivery',
  customer_ordering: 'customer_web',
};

// --- generic catalog core (Phase 3 task 3.2) — docs/phase-3/PHASE-3-PLAN.md §C.3 ---

/**
 * The closed set of product fulfilment strategies (ADR-0018 §1). This is the
 * ONLY behaviour discriminator on a product — `tenant.businessTypeKey` is never
 * read to decide what a product may do (HG3-NO-BT-BRANCH). Mirrored by the
 * `product_fulfilment_strategy_chk` DB CHECK.
 */
export const FULFILMENT_STRATEGIES = ['STOCKED', 'BOM', 'CUSTOM'] as const;
export type FulfilmentStrategy = (typeof FULFILMENT_STRATEGIES)[number];
export const fulfilmentStrategySchema = z.enum(FULFILMENT_STRATEGIES);
export function isFulfilmentStrategy(value: string): value is FulfilmentStrategy {
  return (FULFILMENT_STRATEGIES as readonly string[]).includes(value);
}

/**
 * The catalog-capability key a `fulfilment_strategy` requires to be enabled in
 * `tenant_catalog_capability` (spec §A). The consuming service (task 3.2) does
 * `assertEnabled(CAPABILITY_OF_STRATEGY[strategy])` on product create / a DRAFT
 * strategy change / activate — plus `assertEntitledFor` for the entitlement half
 * (`strategy.bom` → `production_bom`, `strategy.custom` → `custom_composition`,
 * from `CAPABILITY_REQUIRED_ENTITLEMENT`).
 */
export const CAPABILITY_OF_STRATEGY: Readonly<Record<FulfilmentStrategy, CapabilityKey>> =
  Object.freeze({
    STOCKED: 'strategy.stocked',
    BOM: 'strategy.bom',
    CUSTOM: 'strategy.custom',
  });

/** Category / product-type lifecycle — `ACTIVE` ↔ `ARCHIVED` only. */
export const CATALOG_NODE_STATUSES = ['ACTIVE', 'ARCHIVED'] as const;
export type CatalogNodeStatus = (typeof CATALOG_NODE_STATUSES)[number];

/**
 * Product lifecycle. `DRAFT` → `ACTIVE` ↔ `ARCHIVED`; `ACTIVE` → `DRAFT` is
 * never allowed (owner §12). `ACTIVE` means "catalog definition active", NOT
 * "sellable" (owner §7).
 */
export const PRODUCT_STATUSES = ['DRAFT', 'ACTIVE', 'ARCHIVED'] as const;
export type ProductStatus = (typeof PRODUCT_STATUSES)[number];

/** Max category tree depth, root = depth 1 (owner §3 / R-3). Service-enforced on
 *  create + re-parent. */
export const MAX_CATEGORY_DEPTH = 5;

// --- typed attributes (Phase 3 task 3.3) — docs/phase-3/PHASE-3-PLAN.md §C.4 ---

/**
 * The closed set of attribute value types (ADR-0018 risk 3 — no arbitrary JSON,
 * no array-valued storage, NO `MULTISELECT`). `ENUM` = single-select against
 * `attribute_option`. Mirrored by the `attribute_definition_value_type_chk` DB
 * CHECK. Each type maps to exactly one populated column on
 * `product_attribute_value` (`ATTRIBUTE_VALUE_COLUMN`).
 */
export const ATTRIBUTE_VALUE_TYPES = ['TEXT', 'NUMBER', 'ENUM', 'BOOLEAN', 'DATE'] as const;
export type AttributeValueType = (typeof ATTRIBUTE_VALUE_TYPES)[number];
export const attributeValueTypeSchema = z.enum(ATTRIBUTE_VALUE_TYPES);
export function isAttributeValueType(value: string): value is AttributeValueType {
  return (ATTRIBUTE_VALUE_TYPES as readonly string[]).includes(value);
}

/** The one `product_attribute_value` column a value type populates (data-integrity
 *  rule 3 — the service enforces this match; the DB CHECK only enforces
 *  "exactly one populated"). */
export const ATTRIBUTE_VALUE_COLUMN: Readonly<
  Record<AttributeValueType, 'valueText' | 'valueNumber' | 'valueBool' | 'valueDate' | 'optionId'>
> = Object.freeze({
  TEXT: 'valueText',
  NUMBER: 'valueNumber',
  BOOLEAN: 'valueBool',
  DATE: 'valueDate',
  ENUM: 'optionId',
});

/** `attribute_definition` / `attribute_option` lifecycle — `ACTIVE ↔ ARCHIVED`
 *  only (owner K.1; no DRAFT — an attribute is usable on create). */
export const ATTRIBUTE_DEFINITION_STATUSES = ['ACTIVE', 'ARCHIVED'] as const;
export type AttributeDefinitionStatus = (typeof ATTRIBUTE_DEFINITION_STATUSES)[number];

/** `^[A-Z][A-Z0-9_]{1,63}$` — a tenant-defined, immutable attribute key (mirrors
 *  the DB CHECK). */
export const ATTRIBUTE_KEY_RE = /^[A-Z][A-Z0-9_]{1,63}$/;
/** `numeric(18,4)` — a NUMBER attribute value, as a decimal string. No JS float
 *  arithmetic is ever authoritative (owner K.9). */
export const ATTRIBUTE_NUMBER_RE = /^-?\d{1,14}(\.\d{1,4})?$/;

// --- variants + option groups (Phase 3 task 3.4) — docs/phase-3/PHASE-3-PLAN.md §C.5 ---

/**
 * `variant` lifecycle — `DRAFT` → `ACTIVE` ↔ `ARCHIVED`; `ACTIVE` → `DRAFT` is
 * never allowed (mirrors `product`). A variant is a stable catalog identity:
 * once `ACTIVE`, its product link / `isDefault` / option combination are
 * immutable (owner L-9 / "variant identity immutability"). `ACTIVE` means the
 * variant definition is finished — never "sellable" (price / availability /
 * stock are later tasks / Phase 5).
 */
export const VARIANT_STATUSES = ['DRAFT', 'ACTIVE', 'ARCHIVED'] as const;
export type VariantStatus = (typeof VARIANT_STATUSES)[number];

/** `^[A-Z][A-Z0-9_]{1,63}$` — a tenant-defined, immutable option-group key
 *  (`SIZE`, `COLOUR`, `STYLE`…). Mirrors the DB CHECK + `product_type` / attribute
 *  key shape. */
export const OPTION_GROUP_KEY_RE = /^[A-Z][A-Z0-9_]{1,63}$/;
/** `^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$` — a stored option-value token
 *  (`RED`, `M`, `12-inch`). Immutable within a group's replace-set (owner L-11).
 *  Mirrors the task 3.3 `attribute_option` value regex + the DB CHECK. */
export const OPTION_VALUE_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$/;

/**
 * The fulfilment strategies whose products use FIXED variants — a `STOCKED` /
 * `BOM` product with no option groups gets one internal default variant; the
 * same set requires ≥ 1 non-archived structurally-valid variant before the
 * product may become `ACTIVE` (owner L-2 / L-3 / L-10). A `CUSTOM` product uses
 * neither: composition is captured at sale (Phase 6). This constant is the
 * generic behaviour source — catalog code never compares the strategy string
 * literally and never reads `tenant.businessTypeKey` (HG3-NO-BT-BRANCH).
 */
export const STRATEGIES_WITH_FIXED_VARIANTS: readonly FulfilmentStrategy[] = Object.freeze([
  'STOCKED',
  'BOM',
]);
export function usesFixedVariants(strategy: FulfilmentStrategy): boolean {
  return STRATEGIES_WITH_FIXED_VARIANTS.includes(strategy);
}

/** One option selection on a variant — an internal `(optionGroupId, optionValueId)`
 *  id pair, never a display label. */
export interface VariantOptionSelection {
  optionGroupId: string;
  optionValueId: string;
}

/**
 * The deterministic, insertion-order-independent canonical signature of a
 * variant's option combination (owner L-7). Derived by the SERVER from the
 * validated `variant_option_value` rows — never trusted from client input.
 * Sorted by `optionGroupId`, each pair serialised `groupId=valueId`, joined with
 * `|`. The default (no-option) variant's signature is the empty string.
 *
 *   `[Colour=RED, Size=M]` and `[Size=M, Colour=RED]` → the same string
 *   (the ids are opaque UUIDs, so the ordering is stable regardless of labels).
 */
export function variantOptionSignature(selections: readonly VariantOptionSelection[]): string {
  if (selections.length === 0) return '';
  return [...selections]
    .map((s) => `${s.optionGroupId}=${s.optionValueId}`)
    .sort()
    .join('|');
}

// --- identifiers — SKU / barcode / QR (Phase 3 task 3.5) — PHASE-3-PLAN §C.6 ---

/**
 * The closed set of identifier code types (ADR-0018 §5). Mirrors the
 * `item_identifier_code_type_chk` DB CHECK.
 *   - `SKU`     — internal stable code. OPTIONAL, manual, canonical (trim +
 *                 upper-case). At most ONE ACTIVE SKU per variant.
 *   - `BARCODE` — a generic scanner value (EAN-13 / UPC / Code128 / an internal
 *                 code — no symbology parsing, no checksum). MANY ACTIVE per
 *                 variant allowed, each value tenant-unique.
 *   - `QR`      — a server-generated, opaque, cryptographically-random token
 *                 (no tenant / customer / product / price / stock data, no
 *                 embedded JSON). At most ONE ACTIVE QR per variant — 100 printed
 *                 labels are the SAME value printed 100 times.
 */
export const IDENTIFIER_CODE_TYPES = ['SKU', 'BARCODE', 'QR'] as const;
export type IdentifierCodeType = (typeof IDENTIFIER_CODE_TYPES)[number];
export const identifierCodeTypeSchema = z.enum(IDENTIFIER_CODE_TYPES);

/**
 * Identifier lifecycle — `ACTIVE ↔ INACTIVE` on the SAME row (owner decision 5).
 * Deactivation preserves the row and NEVER frees the value: `UNIQUE(tenantId,
 * value)` spans both statuses, so a printed barcode/QR/SKU can never later
 * resolve to a different target. Mirrors the `item_identifier_status_chk` CHECK.
 */
export const IDENTIFIER_STATUSES = ['ACTIVE', 'INACTIVE'] as const;
export type IdentifierStatus = (typeof IDENTIFIER_STATUSES)[number];

/**
 * The identifier target kinds LEGAL at runtime + in the DB in Phase 3a (owner
 * decision 1). Mirrors the `item_identifier_target_kind_chk` CHECK.
 */
export const ACTIVE_IDENTIFIER_TARGET_KINDS = ['VARIANT'] as const;
export type IdentifierTargetKind = (typeof ACTIVE_IDENTIFIER_TARGET_KINDS)[number];

/**
 * A RESERVED FUTURE identifier target kind — documented, **not** legal in Phase
 * 3a. `INVENTORY_ITEM` has no table (D2-11 / HG3-NO-PREMATURE-DOMAIN); a Phase-5
 * migration widens the DB CHECK and adds real referential integrity to
 * `inventory_item` before it becomes a legal value. Kept here so the distinction
 * between "active" and "reserved" target kinds is explicit and testable.
 */
export const RESERVED_IDENTIFIER_TARGET_KIND_INVENTORY_ITEM = 'INVENTORY_ITEM' as const;

/** Max stored identifier value length (the `item_identifier_value_chk` CHECK). */
export const IDENTIFIER_VALUE_MAX_LENGTH = 128;

/**
 * SKU canonical grammar — applied AFTER `canonicalizeSku` (trim + upper-case).
 * `A-Z 0-9 - _ . /`, first char `A-Z 0-9`, 1..64 chars. BARCODE / QR do NOT
 * inherit the upper-casing (owner "SKU NORMALIZATION").
 */
export const SKU_VALUE_RE = /^[A-Z0-9][A-Z0-9._/-]{0,63}$/;

/** A server-generated QR value — 40 upper-case hex chars (160 bits of entropy);
 *  DB uniqueness is the collision backstop (owner "QR SEMANTICS"). */
export const QR_VALUE_RE = /^[0-9A-F]{40}$/;

/**
 * Canonicalize a raw SKU: trim, then upper-case with the Unicode default case
 * mapping (`toUpperCase()` is locale-INDEPENDENT in JS — unlike
 * `toLocaleUpperCase()`). The caller then validates the result against
 * `SKU_VALUE_RE`. `"abc-1"` and `"ABC-1"` canonicalize to the same SKU.
 */
export function canonicalizeSku(raw: string): string {
  return raw.trim().toUpperCase();
}

/**
 * Validate a BARCODE value (owner "BARCODE SEMANTICS"): non-empty after trim,
 * ≤ 128 chars, no leading/trailing whitespace, no control characters. No
 * symbology / checksum validation — a scanner code is accepted verbatim (minus
 * surrounding whitespace). The value is NEVER case-folded.
 */
export function isValidBarcodeValue(trimmed: string): boolean {
  return (
    trimmed.length >= 1 &&
    trimmed.length <= IDENTIFIER_VALUE_MAX_LENGTH &&
    trimmed === trimmed.trim() &&
    !/\p{Cc}/u.test(trimmed)
  );
}

// --- UOM / pack conversion (Phase 3 task 3.6) — PHASE-3-PLAN §C.7 / ADR-0018 ---

/**
 * The UOM families (mirrors `@flower/uom` `UomFamily` + the `uom_family_chk` DB
 * CHECK). `LENGTH` / `MASS` / `VOLUME` / `COUNT` resolve globally via each
 * unit's exact `perBase` ratio; `EACH` units are semantically unrelated — a
 * conversion between two of them (or across families) needs an explicit
 * product-/variant-scoped `uom_conversion` (D0-1).
 */
export const UOM_FAMILIES = ['LENGTH', 'MASS', 'VOLUME', 'COUNT', 'EACH'] as const;
export type UomFamilyKey = (typeof UOM_FAMILIES)[number];
export const uomFamilySchema = z.enum(UOM_FAMILIES);

/**
 * `uom_conversion.scope_kind` — a conversion row is ALWAYS anchored to one
 * variant or one product (D0-1). There is deliberately **no `GLOBAL` value** —
 * cross-family / pack ratios exist only as explicitly-scoped rows. Mirrors the
 * `uom_conversion_scope_kind_chk` DB CHECK.
 */
export const UOM_CONVERSION_SCOPE_KINDS = ['VARIANT', 'PRODUCT'] as const;
export type UomConversionScopeKind = (typeof UOM_CONVERSION_SCOPE_KINDS)[number];
export const uomConversionScopeKindSchema = z.enum(UOM_CONVERSION_SCOPE_KINDS);

/** Max decimal places any UOM quantity may carry — the `Quantity` scale
 *  (NUMERIC(18,4)) and the `uom_max_decimals_chk` upper bound. */
export const UOM_MAX_DECIMALS = 4;

/** Upper bound on the number of scoped conversion rows one replace-set may
 *  submit (a bounded catalog-config write, mirrors the option-set caps). */
export const UOM_CONVERSION_REPLACE_MAX = 100;

/**
 * A raw pack-metadata input for a BARCODE / QR identifier (Task 3.6 §I). The
 * frozen base quantity (`packBaseQty`) is computed server-side with
 * `@flower/uom` `convertExact` and is never client-supplied.
 */
export const identifierPackInputSchema = z
  .object({
    packUomCode: z.string().min(1).max(32),
    /** decimal string, ≤ 4 fractional places, > 0 — validated as a Quantity server-side */
    packQty: z.string().min(1).max(40),
  })
  .strict();
export type IdentifierPackInput = z.infer<typeof identifierPackInputSchema>;

// --- company per-UOM SELL pricing (Phase 3 task 3.7) — PHASE-3-PLAN §C.8 / ADR-0018 §5 ---

/** Max price tiers one replace-set `PUT` may submit (a bounded catalog-config write). */
export const COMPANY_PRICE_REPLACE_MAX = 100;

/**
 * One SELL price-tier in the replace-set body. **SELL only** — `purchase_*` is a
 * schema-only Phase-5 foundation, absent from every Task 3.7 wire contract (D-6).
 * The amount must be `> 0` and in the company's default currency (D-2 / D-8 /
 * Inv-3), validated server-side + DB-enforced.
 */
export const companyPriceEntrySchema = z
  .object({
    /** the variant base UOM OR a UOM resolvable to it via the Task 3.6 conversion model */
    uomCode: z.string().min(1).max(40),
    /** the tax-EXCLUSIVE / net sell price */
    sell: moneyDtoSchema,
  })
  .strict();
export type CompanyPriceEntry = z.infer<typeof companyPriceEntrySchema>;

export const replaceCompanyPricesSchema = z
  .object({ prices: z.array(companyPriceEntrySchema).max(COMPANY_PRICE_REPLACE_MAX) })
  .strict();
export type ReplaceCompanyPricesBody = z.infer<typeof replaceCompanyPricesSchema>;

/** A stored price row as read back — SELL only, plus whether its UOM currently
 *  resolves to the variant base (`false` ⇒ a conversion was deleted, D-5). */
export interface CompanyPriceRowView {
  uomCode: string;
  sell: MoneyDto;
  resolvable: boolean;
}

/** GET `/prices` — the company's own rows + the dedicated price-set version
 *  (`version: 0`, `priceSetExists: false` ⇔ no aggregate yet; ETag `"0"`). */
export interface CompanyVariantPriceSetView {
  version: number;
  priceSetExists: boolean;
  prices: CompanyPriceRowView[];
}

/** GET `/prices/resolve` — a resolved company sell price, or an explicit no-price
 *  state. A missing price is a normal `200` (never a `422` for absence — D-13).
 *  NO branch fallback, NO cross-company fallback, NO price multiplication. */
export const COMPANY_PRICE_RESOLVE_REASONS = [
  'NO_PRICE_SET',
  'UOM_NOT_PRICED',
  'UOM_UNRESOLVABLE',
] as const;
export type CompanyPriceResolveReason = (typeof COMPANY_PRICE_RESOLVE_REASONS)[number];
export interface ResolvedCompanyPrice {
  price: MoneyDto | null;
  source: 'COMPANY' | null;
  reason: CompanyPriceResolveReason | null;
}

/**
 * Numeric per-tenant limits, all distinct (ARCHITECTURE §4 "four distinct
 * counts"). Enforced by `LimitService` on create / activate / login.
 */
export const LIMIT_KEYS = [
  'max_companies',
  'max_branches',
  'max_pos_terminals',
  'max_registered_devices',
  'max_users',
  'max_owner_users',
  'max_pos_concurrent_sessions',
  'max_owner_concurrent_sessions',
  'max_sessions_per_user',
  'storage_bytes',
] as const;
export type LimitKey = (typeof LIMIT_KEYS)[number];
export const limitKeySchema = z.enum(LIMIT_KEYS);

// --- health/readiness (Phase 0) ---
export const healthResponseSchema = z.object({ status: z.literal('ok') });
export type HealthResponse = z.infer<typeof healthResponseSchema>;

export const readinessResponseSchema = z.object({
  status: z.enum(['ok', 'degraded', 'down']),
  checks: z.record(z.string(), z.enum(['ok', 'down'])),
});
export type ReadinessResponse = z.infer<typeof readinessResponseSchema>;
