'use client';

import { createApiClient, type ApiClient, ApiError } from '@flower/api-client';

export { ApiError };

/**
 * The POS PWA is a browser client (OD1): its access + refresh tokens live in
 * device storage and travel as `Authorization: Bearer …` — never a cookie. The
 * API allows this origin via CORS. A later phase moves storage to a more durable
 * store and adds silent refresh.
 */
const ACCESS = 'pos_access';
const REFRESH = 'pos_refresh';

const BASE_URL = process.env['NEXT_PUBLIC_API_BASE_URL'] ?? 'http://localhost:3001';

export function getToken(): string | null {
  try {
    return localStorage.getItem(ACCESS);
  } catch {
    return null;
  }
}

export function setTokens(accessToken: string, refreshToken?: string): void {
  try {
    localStorage.setItem(ACCESS, accessToken);
    if (refreshToken) localStorage.setItem(REFRESH, refreshToken);
  } catch {
    /* private mode / storage disabled — the session is then memory-only */
  }
}

export function clearTokens(): void {
  try {
    localStorage.removeItem(ACCESS);
    localStorage.removeItem(REFRESH);
  } catch {
    /* ignore */
  }
}

/** API client bound to the stored Bearer token. */
export function posApi(): ApiClient {
  return createApiClient({ baseUrl: BASE_URL, getAccessToken: getToken });
}

export function anonApi(): ApiClient {
  return createApiClient({ baseUrl: BASE_URL, getAccessToken: () => null });
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return `${err.code}: ${err.message}`;
  return err instanceof Error ? err.message : 'Unexpected error';
}
