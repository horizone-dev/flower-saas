import { SetMetadata } from '@nestjs/common';
import type { PermissionKey } from '@flower/permissions';

/**
 * Declares the permission a route requires. Enforced by the guard pipeline in
 * Phase 1 (entitlement -> role -> permission -> company scope -> branch scope).
 * The `route-must-declare-permission` lint rule requires every controller route
 * to carry this or `@Public()`.
 */
export const REQUIRED_PERMISSION_KEY = 'flower:requiredPermission';
export const RequirePermission = (permission: PermissionKey): MethodDecorator & ClassDecorator =>
  SetMetadata(REQUIRED_PERMISSION_KEY, permission);
