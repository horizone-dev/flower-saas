'use server';

import { redirect } from 'next/navigation';
import { anonApi, errorMessage } from '@/lib/api';
import { setSession, clearSession } from '@/lib/session';

export async function login(
  _prev: string | undefined,
  formData: FormData,
): Promise<string | undefined> {
  const workspaceSlug = String(formData.get('workspaceSlug') ?? '').trim();
  const email = String(formData.get('email') ?? '').trim();
  const password = String(formData.get('password') ?? '');
  const code = String(formData.get('code') ?? '').trim();

  try {
    const api = anonApi();
    const res = await api.tenantLogin({ workspaceSlug, email, password });

    let accessToken = res.accessToken;
    let refreshToken = res.refreshToken;

    if (res.status === 'mfa_required') {
      if (!code) return 'Multi-factor code required — open your authenticator app.';
      const verified = await api.verifyMfa({ mfaChallenge: res.mfaChallenge ?? '', code });
      accessToken = verified.accessToken;
      refreshToken = verified.refreshToken;
    }
    if (!accessToken) return 'Login failed.';
    await setSession(accessToken, refreshToken);
  } catch (err) {
    return errorMessage(err);
  }
  redirect('/access');
}

export async function logout(): Promise<void> {
  await clearSession();
  redirect('/login');
}
