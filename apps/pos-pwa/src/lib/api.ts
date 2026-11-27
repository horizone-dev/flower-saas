'use client';

import type { ApiClient } from '@flower/api-client';
import { ApiError, bootstrapSession, posApi } from './auth';

/**
 * Run an authenticated API call. If the short-lived access token has expired (401 — the request did NOT execute), refresh it once from the
 * HttpOnly cookie and run the call again. Nothing else is retried here: a network failure or a 5xx is NEVER blindly replayed (the caller decides,
 * using the idempotency keys it owns).
 */
export async function authed<T>(fn: (api: ApiClient) => Promise<T>): Promise<T> {
  try {
    return await fn(posApi());
  } catch (err) {
    if (err instanceof ApiError && err.status === 401 && (await bootstrapSession())) {
      return fn(posApi());
    }
    throw err;
  }
}

/** a fresh random id for an Idempotency-Key */
export function newKey(): string {
  return globalThis.crypto.randomUUID();
}

/** the HTTP status + code behind any thrown value (0 / NETWORK for a failure that never reached the server) */
export function describeError(err: unknown): { status: number; code: string; message: string } {
  if (err instanceof ApiError) return { status: err.status, code: err.code, message: err.message };
  return {
    status: 0,
    code: 'NETWORK',
    message: err instanceof Error ? err.message : 'Unexpected error',
  };
}
