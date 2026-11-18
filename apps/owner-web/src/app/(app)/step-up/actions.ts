'use server';

import { redirect } from 'next/navigation';
import { ApiError, errorMessage, serverApi } from '@/lib/api';

/** only ever return to a path inside this app (never an absolute or protocol-relative URL) */
function safeNext(next: string): string {
  return next.startsWith('/') && !next.startsWith('//') && !next.includes('\\')
    ? next
    : '/products';
}

export async function stepUpAction(
  _prev: string | undefined,
  formData: FormData,
): Promise<string | undefined> {
  const code = String(formData.get('code') ?? '').trim();
  const next = safeNext(String(formData.get('next') ?? '/products'));
  if (!/^\d{6}$/.test(code)) return 'Enter the 6-digit code from your authenticator app.';
  try {
    await serverApi().stepUp(code);
  } catch (err) {
    if (err instanceof ApiError && err.status === 401 && err.code !== 'MFA_FAILED')
      redirect('/login');
    return err instanceof ApiError && err.code === 'MFA_FAILED'
      ? 'That code is not valid. Try the next code.'
      : errorMessage(err);
  }
  redirect(next);
}
