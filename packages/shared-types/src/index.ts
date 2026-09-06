import { z } from 'zod';

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
export { moneyDtoSchema, type MoneyDtoShape as MoneyDto, type MoneyDTO } from '@flower/money';
export {
  quantityDtoSchema,
  type QuantityDtoShape as QuantityDto,
  type QuantityDTO,
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
