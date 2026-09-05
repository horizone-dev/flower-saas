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
] as const;
export type EntitlementModule = (typeof ENTITLEMENT_MODULES)[number];
export const entitlementModuleSchema = z.enum(ENTITLEMENT_MODULES);

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
