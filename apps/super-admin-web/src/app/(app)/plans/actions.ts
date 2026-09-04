'use server';

import { revalidatePath } from 'next/cache';
import { serverApi, errorMessage } from '@/lib/api';

export async function createPlan(
  _prev: string | undefined,
  formData: FormData,
): Promise<string | undefined> {
  try {
    const plan = await serverApi().createPlan({
      key: String(formData.get('key')),
      name: String(formData.get('name')),
    });
    // seed v1 with sensible Starter limits so tenants can be provisioned immediately
    const version = await serverApi().createPlanVersion(plan.id, {
      version: 1,
      limits: [
        { limitKey: 'max_companies', value: 1 },
        { limitKey: 'max_branches', value: 3 },
        { limitKey: 'max_pos_terminals', value: 5 },
        { limitKey: 'max_users', value: 10 },
        { limitKey: 'max_sessions_per_user', value: 5 },
      ],
    });
    await serverApi().publishPlanVersion(version.id);
  } catch (err) {
    return errorMessage(err);
  }
  revalidatePath('/plans');
  return undefined;
}

export async function setEntitlement(formData: FormData): Promise<void> {
  await serverApi().setPlanEntitlement(
    String(formData.get('planVersionId')),
    String(formData.get('moduleKey')),
    formData.get('enabled') === 'true',
  );
  revalidatePath('/plans');
}

export async function setLimit(formData: FormData): Promise<void> {
  await serverApi().setPlanLimit(
    String(formData.get('planVersionId')),
    String(formData.get('limitKey')),
    Number(formData.get('value')),
  );
  revalidatePath('/plans');
}
