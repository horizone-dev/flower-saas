import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Post-Phase-1 auth hardening: the POS PWA must never place an auth token (least
 * of all the refresh token) in JS-readable storage. The access token lives in
 * module memory; the refresh token is a `Secure; HttpOnly` cookie the browser
 * manages and JS cannot see.
 */

const storeSpy = () => ({
  getItem: vi.fn(() => null),
  setItem: vi.fn(),
  removeItem: vi.fn(),
  clear: vi.fn(),
  key: vi.fn(() => null),
  length: 0,
});

const localStorage = storeSpy();
const sessionStorage = storeSpy();
const fetchMock = vi.fn<typeof fetch>();

vi.stubGlobal('localStorage', localStorage);
vi.stubGlobal('sessionStorage', sessionStorage);
vi.stubGlobal('indexedDB', undefined);
vi.stubGlobal('fetch', fetchMock);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('pos-pwa auth storage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockResolvedValue(jsonResponse({ status: 'ok', accessToken: 'access-in-memory' }));
  });

  it('the module never touches a web storage API', () => {
    const src = readFileSync(fileURLToPath(new URL('./auth.ts', import.meta.url)), 'utf8')
      // strip comments — the docstring names the APIs it deliberately avoids
      .replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    expect(src).not.toMatch(/(localStorage|sessionStorage|indexedDB)\s*[.[(]/);
    expect(src).not.toMatch(/document\s*\.\s*cookie/);
  });

  it('setAccessToken keeps the token in memory only — never in storage', async () => {
    const auth = await import('./auth.js');
    auth.setAccessToken('tok-abc');
    expect(auth.getAccessToken()).toBe('tok-abc');
    expect(localStorage.setItem).not.toHaveBeenCalled();
    expect(sessionStorage.setItem).not.toHaveBeenCalled();
  });

  it('bootstrapSession uses the credentialed cookie flow and stores nothing', async () => {
    const auth = await import('./auth.js');
    auth.setAccessToken(null);

    const ok = await auth.bootstrapSession();
    expect(ok).toBe(true);
    expect(auth.getAccessToken()).toBe('access-in-memory');

    const [, init] = fetchMock.mock.calls[0]!;
    expect(String(fetchMock.mock.calls[0]![0])).toMatch(/\/v1\/auth\/refresh$/);
    expect(init?.credentials).toBe('include');
    expect(init?.headers).toMatchObject({ 'x-auth-transport': 'cookie' });
    // no refresh token in the request body (it rides the HttpOnly cookie)
    expect(JSON.parse(String(init?.body ?? '{}'))).not.toHaveProperty('refreshToken');

    expect(localStorage.setItem).not.toHaveBeenCalled();
    expect(sessionStorage.setItem).not.toHaveBeenCalled();
  });

  it('a failed bootstrap clears the in-memory token', async () => {
    const auth = await import('./auth.js');
    auth.setAccessToken('stale');
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: { code: 'REFRESH_INVALID', message: 'x' } }, 401),
    );
    expect(await auth.bootstrapSession()).toBe(false);
    expect(auth.getAccessToken()).toBeNull();
  });
});
