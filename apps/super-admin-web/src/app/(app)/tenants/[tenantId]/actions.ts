'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { serverApi, errorMessage } from '@/lib/api';
import { setImpersonation, clearImpersonation } from '@/lib/impersonation';

export async function overrideLimit(formData: FormData): Promise<void> {
  const tenantId = String(formData.get('tenantId'));
  await serverApi().overrideTenantLimit(
    tenantId,
    String(formData.get('limitKey')),
    Number(formData.get('value')),
    String(formData.get('reason')),
  );
  revalidatePath(`/tenants/${tenantId}`);
}

export async function overrideEntitlement(formData: FormData): Promise<void> {
  const tenantId = String(formData.get('tenantId'));
  await serverApi().overrideTenantEntitlement(
    tenantId,
    String(formData.get('moduleKey')),
    formData.get('enabled') === 'true',
  );
  revalidatePath(`/tenants/${tenantId}`);
}

/**
 * Toggle one catalog capability (task 3.1). `expectedVersion` is the
 * `aggregateVersion` the page was last rendered with — the If-Match precondition
 * (spec §L). On a `409 CATALOG_CAPABILITY_VERSION_CONFLICT` the backend writes
 * NOTHING; the `finally` revalidate re-renders the page with the current version
 * so the Super Admin retries against it (never a silent overwrite).
 */
export async function toggleCatalogCapability(formData: FormData): Promise<void> {
  const tenantId = String(formData.get('tenantId'));
  try {
    await serverApi().patchTenantCatalogCapabilities(
      tenantId,
      [
        {
          capabilityKey: String(formData.get('capabilityKey')),
          enabled: formData.get('enabled') === 'true',
        },
      ],
      Number(formData.get('expectedVersion')),
      'toggled via Super Admin',
    );
  } finally {
    revalidatePath(`/tenants/${tenantId}`);
  }
}

export async function createProviderCredential(
  _prev: string | undefined,
  formData: FormData,
): Promise<string | undefined> {
  const tenantId = String(formData.get('tenantId'));
  try {
    await serverApi().createProviderCredential(tenantId, {
      provider: String(formData.get('provider')),
      mode: (String(formData.get('mode')) as 'TEST' | 'LIVE') || 'TEST',
      secret: String(formData.get('secret')),
    });
  } catch (err) {
    return errorMessage(err);
  }
  revalidatePath(`/tenants/${tenantId}`);
  return undefined;
}

export async function revokeProviderCredential(formData: FormData): Promise<void> {
  const tenantId = String(formData.get('tenantId'));
  await serverApi().revokeProviderCredential(tenantId, String(formData.get('id')));
  revalidatePath(`/tenants/${tenantId}`);
}

export async function startImpersonation(
  _prev: string | undefined,
  formData: FormData,
): Promise<string | undefined> {
  const tenantId = String(formData.get('tenantId'));
  const reason = String(formData.get('reason') ?? '');
  try {
    const res = await serverApi().startImpersonation(tenantId, reason);
    await setImpersonation(tenantId, res.accessToken, res.expiresIn);
  } catch (err) {
    return errorMessage(err);
  }
  redirect(`/tenants/${tenantId}`);
}

export async function stopImpersonation(formData: FormData): Promise<void> {
  const tenantId = String(formData.get('tenantId'));
  await clearImpersonation();
  revalidatePath(`/tenants/${tenantId}`);
}
