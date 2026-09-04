import { z } from 'zod';

/** Shared request schemas for the tenant-realm (`/v1/access`) and platform-realm
 *  (`/v1/platform/tenants/:id/...`) access-admin controllers. */

const roleKey = z
  .string()
  .min(2)
  .max(48)
  .regex(/^[a-z][a-z0-9_]*$/, 'lowercase snake_case');
const permissionKey = z.string().regex(/^[a-z0-9_]+(?::[a-z0-9_]+){1,2}$/);
const uuid = z.string().uuid();

export const createRoleSchema = z.object({
  key: roleKey,
  name: z.string().min(1).max(80),
  permissionKeys: z.array(permissionKey).max(200).default([]),
});

export const rolePermissionsSchema = z.object({
  permissionKeys: z.array(permissionKey).max(200),
});

export const userRolesSchema = z.object({
  roleIds: z.array(uuid).max(50),
});

export const grantsSchema = z.object({
  grants: z
    .array(
      z.object({
        permissionKey,
        effect: z.enum(['ALLOW', 'DENY']),
        reason: z.string().min(3).max(280),
      }),
    )
    .max(200),
});

export const scopeSchema = z.object({
  companyScopeAll: z.boolean(),
  companyIds: z.array(uuid).max(200).default([]),
  branchScopeAll: z.boolean(),
  branchIds: z.array(uuid).max(500).default([]),
  perBranchOverlay: z.record(z.string().uuid(), z.array(permissionKey)).optional(),
});

export const previewSchema = z.object({
  roleIds: z.array(uuid).max(50).optional(),
  grants: z
    .array(z.object({ permissionKey, effect: z.enum(['ALLOW', 'DENY']) }))
    .max(200)
    .optional(),
  scope: z
    .object({
      companyScopeAll: z.boolean().optional(),
      companyIds: z.array(uuid).optional(),
      branchScopeAll: z.boolean().optional(),
      branchIds: z.array(uuid).optional(),
    })
    .optional(),
});
