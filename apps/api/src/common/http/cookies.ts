/**
 * Minimal, dependency-free cookie parse/serialize for the refresh-token cookie
 * (post-Phase-1 auth hardening). Self-contained so it works identically under
 * `main.ts` and `app.inject` integration tests (no plugin registration needed).
 */

export function parseCookies(header: string | string[] | undefined): Record<string, string> {
  const raw = Array.isArray(header) ? header.join('; ') : header;
  const out: Record<string, string> = {};
  if (!raw) return out;
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    if (!name || name in out) continue;
    try {
      out[name] = decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      out[name] = part.slice(eq + 1).trim();
    }
  }
  return out;
}

export interface CookieOptions {
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Lax' | 'Strict' | 'None';
  path?: string;
  /** seconds; 0 clears the cookie */
  maxAge?: number;
  domain?: string;
}

export function serializeCookie(name: string, value: string, opts: CookieOptions = {}): string {
  const segments = [`${name}=${encodeURIComponent(value)}`];
  if (opts.maxAge !== undefined) {
    segments.push(`Max-Age=${Math.floor(opts.maxAge)}`);
    if (opts.maxAge <= 0) segments.push('Expires=Thu, 01 Jan 1970 00:00:00 GMT');
  }
  segments.push(`Path=${opts.path ?? '/'}`);
  if (opts.domain) segments.push(`Domain=${opts.domain}`);
  if (opts.httpOnly) segments.push('HttpOnly');
  if (opts.secure) segments.push('Secure');
  if (opts.sameSite) segments.push(`SameSite=${opts.sameSite}`);
  return segments.join('; ');
}
