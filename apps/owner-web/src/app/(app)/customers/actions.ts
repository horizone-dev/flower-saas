'use server';

import { redirect } from 'next/navigation';
import { ApiError, serverApi } from '@/lib/api';
import { creditSaveMessage, planCreditChange } from '@/lib/customer-credit';
import { ownerOrg, rethrowRedirect } from '@/lib/org';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const str = (f: FormData, n: string): string => String(f.get(n) ?? '').trim();

/**
 * Save a customer's credit settings (on/off, limit). The request goes to the real guarded route: the API decides the permission
 * (`customers:credit:manage`), the step-up requirement, the version check (`If-Match`) and every credit rule. Nothing here validates a
 * financial rule — it turns the form into the strict body, forwards the version the page was rendered with, and reports the server's answer.
 * A step-up that has expired sends the owner to the authenticator prompt and back to this customer (the form must then be submitted again).
 */
export async function saveCustomerCreditAction(form: FormData): Promise<void> {
  const id = str(form, 'customerId');
  if (!UUID.test(id)) redirect('/customers');
  const back = `/customers/${id}`;
  let message: { ok?: string; error?: string };
  try {
    const org = await ownerOrg(back);
    const version = Number(str(form, 'version'));
    if (!Number.isInteger(version) || version < 0) {
      message = { error: 'The page is out of date. Reload and try again.' };
    } else {
      const plan = planCreditChange({
        enabled: str(form, 'creditEnabled') === 'on',
        limitText: str(form, 'creditLimit'),
        exponent: org.exponent,
      });
      if (!plan.ok) {
        message = { error: plan.error };
      } else {
        await serverApi().configureCustomerCredit(org.companyId, id, plan.input, version);
        message = {
          ok: plan.input.creditEnabled
            ? 'Credit settings saved — credit is ON for this customer.'
            : 'Credit settings saved — credit is OFF for this customer.',
        };
      }
    }
  } catch (err) {
    rethrowRedirect(err);
    if (err instanceof ApiError && err.status === 401) redirect('/login');
    if (err instanceof ApiError && err.code === 'STEP_UP_REQUIRED')
      redirect(`/step-up?next=${encodeURIComponent(back)}`);
    message = {
      error:
        err instanceof ApiError
          ? creditSaveMessage(err.code, err.status)
          : err instanceof Error
            ? err.message
            : 'Unexpected error',
    };
  }
  redirect(
    `${back}?${message.error ? 'error' : 'ok'}=${encodeURIComponent(message.error ?? message.ok ?? 'Saved')}`,
  );
}
