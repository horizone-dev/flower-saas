import {
  healthResponseSchema,
  readinessResponseSchema,
  apiErrorSchema,
  type HealthResponse,
  type ReadinessResponse,
} from '@flower/shared-types';

/**
 * Phase 0 seed of the typed REST client. Later phases replace the hand-written
 * methods with an OpenAPI-generated surface; the transport (auth headers,
 * Idempotency-Key, error envelope, retries/backoff) stays here.
 */

export interface ApiClientOptions {
  baseUrl: string;
  /** injected so the client never reaches for a global fetch implicitly */
  fetch?: typeof fetch;
  /** returns the current access token, or null when unauthenticated */
  getAccessToken?: () => string | null | Promise<string | null>;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly correlationId?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export class ApiClient {
  private readonly baseUrl: string;
  private readonly doFetch: typeof fetch;
  private readonly getAccessToken: () => string | null | Promise<string | null>;

  constructor(opts: ApiClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    const f = opts.fetch ?? globalThis.fetch;
    if (!f) throw new Error('No fetch implementation available; pass one via options');
    this.doFetch = f;
    this.getAccessToken = opts.getAccessToken ?? (() => null);
  }

  private async request<T>(path: string, parse: (raw: unknown) => T): Promise<T> {
    const token = await this.getAccessToken();
    const headers: Record<string, string> = { accept: 'application/json' };
    if (token) headers['authorization'] = `Bearer ${token}`;

    const res = await this.doFetch(`${this.baseUrl}${path}`, { headers });
    const body: unknown = await res.json().catch(() => undefined);

    if (!res.ok) {
      const err = apiErrorSchema.safeParse(body);
      if (err.success) {
        throw new ApiError(
          res.status,
          err.data.error.code,
          err.data.error.message,
          err.data.error.correlationId,
        );
      }
      throw new ApiError(res.status, 'UNKNOWN', `Request failed with ${res.status}`);
    }
    return parse(body);
  }

  health(): Promise<HealthResponse> {
    return this.request('/healthz', (raw) => healthResponseSchema.parse(raw));
  }

  readiness(): Promise<ReadinessResponse> {
    return this.request('/readyz', (raw) => readinessResponseSchema.parse(raw));
  }
}

export function createApiClient(opts: ApiClientOptions): ApiClient {
  return new ApiClient(opts);
}
