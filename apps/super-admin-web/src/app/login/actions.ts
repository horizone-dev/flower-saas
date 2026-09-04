'use server';

import { redirect } from 'next/navigation';
import { serverApi, errorMessage } from '@/lib/api';
import { setSession, clearSession } from '@/lib/session';

export async function login(
  _prev: string | undefined,
  formData: FormData,
): Promise<string | undefined> {
  const email = String(formData.get('email') ?? '');
  const password = String(formData.get('password') ?? '');
  const code = String(formData.get('code') ?? '');

  try {
    const res = await serverApi().platformLogin({
      email,
      password,
      ...(code ? { code } : {}),
    });
    if (res.status !== 'ok' || !res.accessToken) {
      return 'MFA required — enter your authenticator code.';
    }
    await setSession(res.accessToken, res.refreshToken);
  } catch (err) {
    return errorMessage(err);
  }
  redirect('/tenants');
}

export async function logout(): Promise<void> {
  await clearSession();
  redirect('/login');
}
