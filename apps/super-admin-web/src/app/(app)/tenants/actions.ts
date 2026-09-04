'use server';

import { randomUUID } from 'node:crypto';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { serverApi, errorMessage } from '@/lib/api';

export async function provisionTenant(
  _prev: string | undefined,
  formData: FormData,
): Promise<string | undefined> {
  const input = {
    slug: String(formData.get('slug') ?? ''),
    name: String(formData.get('name') ?? ''),
    region: String(formData.get('region') ?? 'AE'),
    planVersionId: String(formData.get('planVersionId') ?? ''),
    ownerEmail: String(formData.get('ownerEmail') ?? ''),
  };
  let tenantId: string;
  try {
    const res = await serverApi().provisionTenant(input, `sa-${randomUUID()}`);
    tenantId = res.tenantId;
  } catch (err) {
    return errorMessage(err);
  }
  revalidatePath('/tenants');
  redirect(`/tenants/${tenantId}`);
}

export async function tenantLifecycle(formData: FormData): Promise<void> {
  const tenantId = String(formData.get('tenantId'));
  const action = String(formData.get('action')) as 'suspend' | 'resume' | 'terminate';
  const reason = String(formData.get('reason') ?? '') || undefined;
  await serverApi().tenantLifecycle(tenantId, action, reason);
  revalidatePath(`/tenants/${tenantId}`);
  revalidatePath('/tenants');
}
