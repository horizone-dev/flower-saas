'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { serverApi, errorMessage } from '@/lib/api';

const PHASE1_KEYS = [
  'users:view',
  'users:manage',
  'roles:manage',
  'audit:view',
  'settings:branch:manage',
  'settings:tenant:manage',
];

function pickKeys(formData: FormData): string[] {
  return PHASE1_KEYS.filter((k) => formData.get(`perm:${k}`) === 'on');
}

export async function createRole(
  _prev: string | undefined,
  formData: FormData,
): Promise<string | undefined> {
  const tenantId = String(formData.get('tenantId'));
  try {
    await serverApi().createTenantRole(tenantId, {
      key: String(formData.get('key')),
      name: String(formData.get('name')),
      permissionKeys: pickKeys(formData),
    });
  } catch (err) {
    return errorMessage(err);
  }
  revalidatePath(`/tenants/${tenantId}/access`);
  return undefined;
}

export async function assignRoles(
  _prev: string | undefined,
  formData: FormData,
): Promise<string | undefined> {
  const tenantId = String(formData.get('tenantId'));
  const userId = String(formData.get('userId'));
  const roleIds = formData.getAll('roleId').map(String);
  try {
    await serverApi().setTenantUserRoles(tenantId, userId, roleIds);
  } catch (err) {
    return errorMessage(err);
  }
  redirect(`/tenants/${tenantId}/access?user=${userId}`);
}

export async function setScope(
  _prev: string | undefined,
  formData: FormData,
): Promise<string | undefined> {
  const tenantId = String(formData.get('tenantId'));
  const userId = String(formData.get('userId'));
  const branchScopeAll = formData.get('branchScopeAll') === 'on';
  const branchIds = String(formData.get('branchIds') ?? '')
    .split(/[\s,]+/)
    .filter(Boolean);
  try {
    await serverApi().setTenantUserScope(tenantId, userId, {
      companyScopeAll: true,
      companyIds: [],
      branchScopeAll,
      branchIds,
    });
  } catch (err) {
    return errorMessage(err);
  }
  redirect(`/tenants/${tenantId}/access?user=${userId}`);
}
