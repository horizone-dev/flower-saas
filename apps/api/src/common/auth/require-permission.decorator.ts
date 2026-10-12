import { SetMetadata } from '@nestjs/common';
import type { PermissionKey, PlatformPermissionKey } from '@flower/permissions';

/**
 * Declares the permission a route requires. Enforced by the guard pipeline
 * (entitlement -> permission + step-up -> company scope -> branch scope). The
 * `route-must-declare-permission` lint rule requires every controller route to
 * carry this or `@Public()`.
 */
export const REQUIRED_PERMISSION_KEY = 'flower:requiredPermission';

/**
 * ADDITIVE: further permissions that must ALL also be held on top of the route's `@RequirePermission(...)` key (which stays
 * the route's declared primary key for the lint rule and the route table). Every key is checked by the same engine, with the
 * same target and the same deny-by-default order; missing any one denies. Never a way to relax a route.
 */
export const REQUIRED_ALL_PERMISSIONS_KEY = 'flower:requiredAllPermissions';
export const RequireAllPermissions = (
  ...permissions: PermissionKey[]
): MethodDecorator & ClassDecorator => SetMetadata(REQUIRED_ALL_PERMISSIONS_KEY, permissions);

/**
 * Marks a COMPANY-WIDE route (one that spans every branch of the company): the caller must hold unrestricted branch
 * authority (`branchScope === 'ALL'`, no narrowing per-branch overlay). Denied callers get the non-disclosing 404.
 */
export const REQUIRES_ALL_BRANCHES_KEY = 'flower:requiresAllBranches';
export const RequireAllBranches = (): MethodDecorator & ClassDecorator =>
  SetMetadata(REQUIRES_ALL_BRANCHES_KEY, true);

export const RequirePermission = (
  permission: PermissionKey | PlatformPermissionKey,
): MethodDecorator & ClassDecorator => SetMetadata(REQUIRED_PERMISSION_KEY, permission);
