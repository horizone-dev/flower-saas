'use client';

import { createApiClient, type ApiClient, ApiError } from '@flower/api-client';
import { clearCollections, sessionKeyValueStore } from './collection-store';

export { ApiError };

/**
 * POS PWA auth (post-Phase-1 hardening).
 *
 * - The **access token** lives ONLY in this module's memory — never
 *   localStorage / sessionStorage / IndexedDB. A tab reload drops it and is
 *   re-bootstrapped from the refresh cookie.
 * - The **refresh token** is a `Secure; HttpOnly; SameSite=Lax` cookie set by
 *   the API on `/v1/auth/*` (Path-scoped there) and is never readable by JS.
 * - Protected API calls stay Bearer (`Authorization` header). `credentials:
 *   'include'` + `x-auth-transport: cookie` opt the auth calls into the cookie
 *   flow; the header also blocks CSRF on the cookie-authenticated refresh.
 */
// NOTE: Next.js inlines `NEXT_PUBLIC_*` into the BROWSER bundle only for the literal dotted form `process.env.NEXT_PUBLIC_X` — the bracket form
// is left as a runtime lookup that is always undefined in a browser (the till would silently call localhost:3001). An EMPTY value means
// "same origin" (the `/v1` proxy in next.config.ts).
const BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:3001';

let accessToken: string | null = null; // in-memory only

export function getAccessToken(): string | null {
  return accessToken;
}
export function setAccessToken(token: string | null): void {
  accessToken = token;
}

function makeClient(authed: boolean): ApiClient {
  return createApiClient({
    baseUrl: BASE_URL,
    credentials: 'include',
    headers: { 'x-auth-transport': 'cookie' },
    getAccessToken: authed ? () => accessToken : () => null,
  });
}

/** Authenticated client (Bearer access token). */
export const posApi = (): ApiClient => makeClient(true);
/** Unauthenticated client — for login and the cookie-based refresh. */
export const anonApi = (): ApiClient => makeClient(false);

/** Exchange the HttpOnly refresh cookie for a fresh in-memory access token.
 *  Returns false when there is no valid cookie (i.e. not signed in). */
export async function bootstrapSession(): Promise<boolean> {
  try {
    const res = await anonApi().refresh();
    if (res.status === 'ok' && res.accessToken) {
      accessToken = res.accessToken;
      return true;
    }
  } catch {
    /* no / expired cookie */
  }
  accessToken = null;
  return false;
}

/** End the session: revoke server-side (session + refresh family) + clear the
 *  refresh cookie + drop the in-memory access token. Bootstraps a token first
 *  if the in-memory one is gone, so "sign out" always reaches the server. */
export async function signOut(): Promise<void> {
  try {
    if (!accessToken) await bootstrapSession();
    if (accessToken) await posApi().logout();
  } catch {
    /* best effort — the cookie also expires on its own */
  }
  accessToken = null;
  // the collection receipts kept for reprinting belong to the session that made them
  clearCollections(sessionKeyValueStore());
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return `${err.code}: ${err.message}`;
  return err instanceof Error ? err.message : 'Unexpected error';
}
