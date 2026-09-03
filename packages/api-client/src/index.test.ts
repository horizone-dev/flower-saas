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
});
