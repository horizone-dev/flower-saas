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

/** A request-scoped API client that carries the Super Admin's HttpOnly-cookie
 *  token. Server components + server actions only. */
export function serverApi(): ApiClient {
  return createApiClient({
    baseUrl: baseUrl(),
    getAccessToken,
  });
}

/** A client bound to a one-off bearer token (impersonation flows). */
export function tokenApi(token: string): ApiClient {
  return createApiClient({ baseUrl: baseUrl(), getAccessToken: () => token });
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return `${err.code}: ${err.message}`;
  return err instanceof Error ? err.message : 'Unexpected error';
}
