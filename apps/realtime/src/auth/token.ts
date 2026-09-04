import type { FastifyRequest } from 'fastify';

/**
 * Extract the access token from a WS upgrade request. Checked in order:
 * `Authorization: Bearer …` header → `flower_access` cookie (browser session
 * clients, OD1) → `?token=` query string (any WS client that cannot set a
 * custom header on the handshake — including the browser-native `WebSocket`
 * constructor itself; a query-string token is the standard workaround for
 * exactly this limitation).
 *
 * Deliberately **not** shared with `apps/api` — this is transport-specific
 * extraction (SECURITY.md), not the verification logic (that *is* shared,
 * via `@flower/backend`'s `SessionAuthenticator`). No new dependency
 * (`@fastify/cookie`) is added just for this — a WS handshake's raw `Cookie`
 * header is trivial to read.
 */
export function extractToken(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  const value = Array.isArray(h) ? h[0] : h;
  if (value?.toLowerCase().startsWith('bearer ')) {
    const token = value.slice(7).trim();
    if (token) return token;
  }

  const cookieHeader = req.headers.cookie;
  if (cookieHeader) {
    const fromCookie = parseCookie(cookieHeader, 'flower_access');
    if (fromCookie) return fromCookie;
  }

  const query = req.query as Record<string, unknown> | undefined;
  const fromQuery = query?.['token'];
  if (typeof fromQuery === 'string' && fromQuery.length > 0) return fromQuery;

  return null;
}

function parseCookie(header: string, name: string): string | null {
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) {
      return decodeURIComponent(part.slice(idx + 1).trim());
    }
  }
  return null;
}
