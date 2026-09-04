import { createApiClient, type ApiClient, ApiError } from '@flower/api-client';
import { getAccessToken } from './session';

export { ApiError };

function baseUrl(): string {
  return (
    process.env['API_BASE_URL'] ??
    process.env['NEXT_PUBLIC_API_BASE_URL'] ??
    'http://localhost:3001'
  );
}

/** Request-scoped API client carrying the Owner's HttpOnly-cookie token (OD1).
 *  Server components + server actions only. */
export function serverApi(): ApiClient {
  return createApiClient({ baseUrl: baseUrl(), getAccessToken });
}

export function anonApi(): ApiClient {
  return createApiClient({ baseUrl: baseUrl(), getAccessToken: () => null });
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return `${err.code}: ${err.message}`;
  return err instanceof Error ? err.message : 'Unexpected error';
}
