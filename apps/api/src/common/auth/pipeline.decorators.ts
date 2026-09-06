import { SetMetadata } from '@nestjs/common';

/**
 * Marks a route / controller as belonging to the **platform** auth realm
 * (default is `tenant`). The realms are never cross-grantable — a tenant token is
 * rejected on a platform route and vice-versa (SECURITY.md).
 */
export const PLATFORM_REALM_KEY = 'flower:platformRealm';
export const PlatformRealm = (): MethodDecorator & ClassDecorator =>
  SetMetadata(PLATFORM_REALM_KEY, true);

/**
 * Names the route params / query keys that hold the company / branch id the
 * request targets, so the scope guard can check them against the caller's scope.
 * List endpoints omit this and inject the scope filter in the repository instead.
 */
export interface ScopedParamConfig {
  /** route-param name holding the company id (e.g. 'companyId') */
  company?: string;
  /** route-param name holding the branch id (e.g. 'branchId') */
  branch?: string;
  /** read from `query` instead of `params` */
  from?: 'params' | 'query';
}
export const SCOPED_PARAM_KEY = 'flower:scopedParam';
export const ScopedParam = (config: ScopedParamConfig): MethodDecorator =>
  SetMetadata(SCOPED_PARAM_KEY, config);

/** Marks a route that genuinely needs POS-terminal scope (cash session, device
 *  binding). None in Phase 1 beyond session/terminal binding. */
export const REQUIRES_POS_SCOPE_KEY = 'flower:requiresPosScope';
export const RequiresPosScope = (): MethodDecorator => SetMetadata(REQUIRES_POS_SCOPE_KEY, true);

/**
 * Opts a route OUT of the step-up requirement its `@RequirePermission(...)` key
 * would otherwise carry (`STEP_UP_PERMISSIONS`). Use ONLY on a plain read whose
 * permission is normally a mutation key — task 3.1's
 * `GET /v1/platform/tenants/:id/catalog-capabilities` uses
 * `platform:catalog_capability:manage` (step-up-gated) but is a read (owner R-7).
 * A forgotten `@NoStepUp()` on a future read just means an unnecessary step-up
 * prompt — never a security hole (the default is fail-safe).
 */
export const NO_STEP_UP_KEY = 'flower:noStepUp';
export const NoStepUp = (): MethodDecorator => SetMetadata(NO_STEP_UP_KEY, true);

/**
 * Declares that a route is an auditable mutation (amendment 2). The audit
 * interceptor writes the record(s) in the same transaction as the mutation
 * (task 1.14). `resourceIdParam` names the route param holding the resource id.
 */
export interface AuditedConfig {
  action: string;
  resourceType: string;
  resourceIdParam?: string;
}
export const AUDITED_KEY = 'flower:audited';
export const Audited = (config: AuditedConfig): MethodDecorator => SetMetadata(AUDITED_KEY, config);
