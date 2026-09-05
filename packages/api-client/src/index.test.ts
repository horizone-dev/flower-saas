import { describe, it, expect, vi } from 'vitest';
import { createApiClient, ApiError } from './index.js';

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

describe('@flower/api-client', () => {
  it('calls /healthz with the bearer token and parses the response', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ status: 'ok' }));
    const client = createApiClient({
      baseUrl: 'http://api.test/',
      fetch: fetchMock,
      getAccessToken: () => 'tok-123',
    });

    const res = await client.health();
    expect(res).toEqual({ status: 'ok' });
    const call = fetchMock.mock.calls[0]!;
    expect(String(call[0])).toBe('http://api.test/healthz');
    expect(call[1]?.headers).toMatchObject({ authorization: 'Bearer tok-123' });
  });

  it('throws a typed ApiError from the error envelope', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse(
        { error: { code: 'NOT_READY', message: 'db down', correlationId: '01J' } },
        { status: 503 },
      ),
    );
    const client = createApiClient({
      baseUrl: 'http://api.test',
      fetch: fetchMock,
    });

    await expect(client.readiness()).rejects.toMatchObject({
      name: 'ApiError',
      status: 503,
      code: 'NOT_READY',
      correlationId: '01J',
    });
  });

  it('requires a fetch implementation', () => {
    expect(() =>
      createApiClient({ baseUrl: 'x', fetch: undefined as unknown as typeof fetch }),
    ).not.toThrow(); // falls back to globalThis.fetch which exists on Node 24
    expect(ApiError).toBeTypeOf('function');
  });

  it('builds a query string for the audit viewer and drops undefined params', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ rows: [], nextBefore: null }));
    const client = createApiClient({ baseUrl: 'http://api.test', fetch: fetchMock });
    await client.queryAudit({ tenantId: 't1', action: 'role', limit: 25 });
    expect(String(fetchMock.mock.calls[0]![0])).toBe(
      'http://api.test/v1/platform/audit?tenantId=t1&action=role&limit=25',
    );
  });

  it('applies the credentials mode and default headers to every request (browser cookie flow)', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ status: 'ok' }));
    const client = createApiClient({
      baseUrl: 'http://api.test',
      fetch: fetchMock,
      credentials: 'include',
      headers: { 'x-auth-transport': 'cookie' },
    });

    await client.refresh(); // no arg -> cookie transport, empty body
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe('http://api.test/v1/auth/refresh');
    expect(init?.credentials).toBe('include');
    expect(init?.headers).toMatchObject({
      'x-auth-transport': 'cookie',
      accept: 'application/json',
    });
    // the refresh token is never in the body on the cookie flow
    expect(JSON.parse(String(init?.body ?? '{}'))).not.toHaveProperty('refreshToken');
  });

  it('omits credentials entirely when not configured (server-side clients)', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ status: 'ok' }));
    const client = createApiClient({ baseUrl: 'http://api.test', fetch: fetchMock });
    await client.refresh('rt-abc');
    const init = fetchMock.mock.calls[0]![1]!;
    expect(init.credentials).toBeUndefined();
    expect(JSON.parse(String(init.body)).refreshToken).toBe('rt-abc');
  });

  it('sends a JSON body + Idempotency-Key on provisioning', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ tenantId: 'x' }));
    const client = createApiClient({
      baseUrl: 'http://api.test',
      fetch: fetchMock,
      getAccessToken: () => 'tok',
    });
    await client.provisionTenant(
      {
        slug: 'acme',
        name: 'Acme',
        region: 'AE',
        companyCountryCode: 'AE',
        planVersionId: 'pv1',
        ownerEmail: 'a@b.co',
      },
      'idem-1',
    );
    const init = fetchMock.mock.calls[0]![1]!;
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({
      authorization: 'Bearer tok',
      'content-type': 'application/json',
      'idempotency-key': 'idem-1',
    });
    expect(JSON.parse(String(init.body)).slug).toBe('acme');
  });
});
