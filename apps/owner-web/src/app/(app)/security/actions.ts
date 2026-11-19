'use server';

import { redirect } from 'next/navigation';
import { ApiError, errorMessage, serverApi } from '@/lib/api';
import { groupSecret, parseTotpCode, qrSvg } from '@/lib/mfa';
import { endSession } from '@/lib/end-session';

/**
 * Authenticator (TOTP) enrolment — a thin shell over the EXISTING approved routes `POST /v1/auth/mfa/enrol` and `/mfa/confirm`. The API
 * creates the PENDING factor and decides whether a code is correct; nothing here is a security rule. The secret is returned to the page ONCE,
 * in the action result (never in a URL, cookie, header or log), and is gone as soon as the factor is confirmed (the action then ends the
 * session and redirects to sign-in).
 */
export interface EnrolState {
  phase: 'idle' | 'enrolling';
  /** the secret grouped for manual entry — shown while `enrolling`, absent otherwise */
  secret?: string;
  /** inline SVG of the QR code (numbers only; safe to inject) */
  svg?: string;
  error?: string;
}

/** a 401 that is NOT a wrong code means the session ended: send the user to sign in (never show the raw API error) */
function failure(err: unknown): string {
  if (err instanceof ApiError && err.status === 401 && err.code !== 'MFA_FAILED')
    redirect('/login');
  if (err instanceof ApiError && err.code === 'MFA_FAILED')
    return 'That code is not correct. Check the time on your phone, wait for the next code and try again.';
  return errorMessage(err);
}

async function start(prev: EnrolState, formData: FormData): Promise<EnrolState> {
  // The API does not say whether this account already has an authenticator (a password-only and an MFA session both read `MFA`, and
  // step-up answers the same either way), so the user must state this is a FIRST-time setup. This is a UX safeguard, not a security
  // control: the server-side refusal needs an approved API change (see the approval sheet, item M-1).
  if (String(formData.get('ack') ?? '') !== 'yes') {
    return {
      phase: 'idle',
      error: 'Tick the box to confirm this account has no authenticator yet.',
    };
  }
  try {
    const { secret, uri } = await serverApi().enrolMfa();
    return { phase: 'enrolling', secret: groupSecret(secret), svg: qrSvg(uri) };
  } catch (err) {
    return { ...prev, error: failure(err) };
  }
}

/** returns an error state, or `null` once the factor is confirmed */
async function confirm(prev: EnrolState, formData: FormData): Promise<EnrolState | null> {
  const code = parseTotpCode(String(formData.get('code') ?? ''));
  // keep what is on screen so the user can retry; `prev` is trusted for display only
  if (!code) return { ...prev, error: 'Enter the 6-digit code shown in your authenticator app.' };
  try {
    await serverApi().confirmMfa(code);
  } catch (err) {
    return { ...prev, error: failure(err) };
  }
  // end THIS browser session: it was issued before the second factor existed (it still reads as password-only), so it must not be reused —
  // the next sign-in asks for the code
  await endSession();
  return null;
}

export async function enrolAction(prev: EnrolState, formData: FormData): Promise<EnrolState> {
  const intent = String(formData.get('intent') ?? '');
  if (intent === 'start') return start(prev, formData);
  if (intent === 'confirm') {
    const failed = await confirm(prev, formData);
    if (failed) return failed;
    redirect('/login?mfa=enabled'); // outside any try/catch: redirect() works by throwing
  }
  return { ...prev, error: 'Unknown request.' };
}
