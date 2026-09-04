/**
 * Build the replayable response snapshot for the idempotency store (task 2.2,
 * constraint 6). Only a 2xx JSON body is ever stored, and:
 *   - sensitive-looking keys are redacted (defence in depth — an idempotent
 *     domain route should not return a secret in the first place);
 *   - a body over `maxBytes` is NOT stored (the key still transitions to DONE so
 *     the mutation cannot re-run; a replay reports that the body was not cached);
 *   - streaming / binary / non-serialisable bodies are NOT stored.
 * Response **headers** are never captured, so `Set-Cookie` / `Authorization`
 * cannot leak into a snapshot by construction.
 */

const SENSITIVE_WORDS = new Set([
  'cookie',
  'setcookie',
  'authorization',
  'auth',
  'bearer',
  'token',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'jwt',
  'secret',
  'clientsecret',
  'password',
  'passwd',
  'pwd',
  'passphrase',
  'credential',
  'credentials',
  'apikey',
  'privatekey',
  'signingkey',
  'session',
  'sessionid',
  'otp',
  'mfacode',
  'pin',
  'cvv',
  'cvc',
  'cardnumber',
  'pan',
  'iban',
  'ssn',
]);

/** camelCase / snake_case / kebab-case → lowercase word segments */
function keySegments(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_\-\s]+/g, ' ')
    .trim()
    .toLowerCase()
    .split(' ')
    .filter(Boolean);
}

export function isSensitiveKey(key: string): boolean {
  const segments = keySegments(key);
  if (segments.length === 0) return false;
  if (SENSITIVE_WORDS.has(segments.join(''))) return true;
  if (segments.some((s) => SENSITIVE_WORDS.has(s))) return true;
  for (let i = 0; i < segments.length - 1; i++) {
    if (SENSITIVE_WORDS.has(segments[i]! + segments[i + 1]!)) return true;
  }
  return false;
}

export function scrubSensitive(value: unknown, depth = 0): unknown {
  if (depth > 20) return '[depth-limited]';
  if (Array.isArray(value)) return value.map((v) => scrubSensitive(v, depth + 1));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      out[key] = isSensitiveKey(key) ? '[redacted]' : scrubSensitive(v, depth + 1);
    }
    return out;
  }
  return value;
}

export type SnapshotResult =
  | { stored: true; body: unknown }
  | { stored: false; reason: 'binary' | 'stream' | 'non-serialisable' | 'too-large' };

export function buildSnapshot(body: unknown, maxBytes: number): SnapshotResult {
  if (body === undefined) return { stored: true, body: null };
  if (Buffer.isBuffer(body) || body instanceof Uint8Array || body instanceof ArrayBuffer) {
    return { stored: false, reason: 'binary' };
  }
  if (
    body !== null &&
    typeof body === 'object' &&
    (typeof (body as { getStream?: unknown }).getStream === 'function' ||
      typeof (body as { pipe?: unknown }).pipe === 'function')
  ) {
    return { stored: false, reason: 'stream' };
  }

  // Reject a circular / non-serialisable body on the ORIGINAL value first —
  // scrubbing would otherwise mask a cycle with its depth guard.
  try {
    if (JSON.stringify(body) === undefined) return { stored: true, body: null };
  } catch {
    return { stored: false, reason: 'non-serialisable' };
  }

  let scrubbed: unknown;
  let json: string;
  try {
    scrubbed = scrubSensitive(body);
    json = JSON.stringify(scrubbed) ?? 'null';
  } catch {
    return { stored: false, reason: 'non-serialisable' };
  }
  if (Buffer.byteLength(json, 'utf8') > maxBytes) return { stored: false, reason: 'too-large' };
  return { stored: true, body: scrubbed };
}
