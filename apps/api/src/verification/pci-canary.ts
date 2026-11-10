import { randomInt, randomUUID } from 'node:crypto';

/**
 * Task 3b.11 — synthetic card-data canaries and the leak detector used by the PCI bounded-negative verification.
 *
 * Everything here is SYNTHETIC. A canary PAN is generated at run time from a non-issuable prefix and a random body, then
 * given a valid Luhn check digit; it is never a real card number, is never written to a repository file, never leaves the
 * disposable local test stack, and is only ever reported by masked form (`****1234`). The detector proves BOUNDED negative
 * statements ("none of these canary forms was found on these surfaces"); it cannot prove that no card data exists anywhere.
 */

/** the issuer-identification prefix of every canary PAN: not assigned to any card network */
const CANARY_PREFIX = '999999';

export function luhnValid(digits: string): boolean {
  if (!/^\d+$/.test(digits)) return false;
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

function checkDigit(partial: string): string {
  for (let d = 0; d <= 9; d++) if (luhnValid(partial + String(d))) return String(d);
  throw new Error('unreachable: a Luhn check digit always exists');
}

/** a Luhn-valid synthetic PAN of `length` digits (default 16) */
export function makePan(length = 16): string {
  let body = CANARY_PREFIX;
  while (body.length < length - 1) body += String(randomInt(0, 10));
  return body + checkDigit(body);
}

export const mask = (s: string): string => `${'*'.repeat(Math.max(0, s.length - 4))}${s.slice(-4)}`;

export interface Canary {
  readonly marker: string;
  readonly pan: string;
  readonly cvv: string;
  readonly expiry: string;
  readonly track2: string;
  /** the exact strings searched for (each a different disguise of the same PAN) */
  readonly panForms: Readonly<Record<string, string>>;
  /** marker-tagged values for free-text and unknown fields (every one contains the marker) */
  readonly tagged: Readonly<Record<'pan' | 'cvv' | 'expiry' | 'track2', string>>;
}

const groups = (s: string, sep: string): string => (s.match(/.{1,4}/g) ?? []).join(sep);

export function makeCanary(length = 16): Canary {
  const pan = makePan(length);
  const marker = `PCICANARY${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const cvv = String(randomInt(100, 1000));
  const expiry = `${String(randomInt(1, 13)).padStart(2, '0')}/${String(randomInt(30, 40))}`;
  const track2 = `;${pan}=${expiry.replace('/', '')}${cvv}?`;
  const spaced = groups(pan, ' ');
  return {
    marker,
    pan,
    cvv,
    expiry,
    track2,
    panForms: {
      plain: pan,
      spaced,
      dashed: groups(pan, '-'),
      dotted: groups(pan, '.'),
      urlEncoded: encodeURIComponent(spaced),
      base64Plain: Buffer.from(pan).toString('base64'),
      base64Spaced: Buffer.from(spaced).toString('base64'),
      hexPlain: Buffer.from(pan).toString('hex'),
      track2,
    },
    tagged: {
      pan: `${marker}:pan=${pan}`,
      cvv: `${marker}:cvv=${cvv}`,
      expiry: `${marker}:exp=${expiry}`,
      track2: `${marker}:trk=${track2}`,
    },
  };
}

export type HitKind = 'marker' | `form:${string}` | 'generic-luhn' | 'card-key';
export interface Hit {
  kind: HitKind;
  /** a masked excerpt: never the raw canary */
  masked: string;
}

const UUID_RE = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g;
/** a run of 15–19 digits, optionally grouped by single spaces / dashes / dots, not part of a longer digit run */
const GENERIC_RE = /(?<!\d)\d(?:[ .-]?\d){14,18}(?!\d)/g;
/** property names that would hold card data (a bare `expiresAt` / `expires` is a session lifetime, not a card field) */
export const CARD_KEY_RE =
  /^(?:pan|primaryAccountNumber|cardNumber|card_number|cardNo|cvv|cvc|cvv2|cvc2|cvn|securityCode|track[12]?(?:Data)?|magstripe|pinBlock|pin|cardholder(?:Name)?|expMonth|expYear|exp_month|exp_year|cardExpiry|card_expiry|expiryDate|expirationDate)$/i;

/** every JSON property name in `value` that looks like a card-data field */
export function cardKeys(value: unknown, depth = 0): string[] {
  if (depth > 12 || value === null || typeof value !== 'object') return [];
  if (Array.isArray(value)) return value.flatMap((v) => cardKeys(v, depth + 1));
  return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => [
    ...(CARD_KEY_RE.test(k) ? [k] : []),
    ...cardKeys(v, depth + 1),
  ]);
}

/**
 * Scan one text. `canary` (optional) adds the exact-form and marker checks, which have no false positives; the generic
 * Luhn scan is the defence against UNKNOWN card numbers (it can false-positive on a long numeric id, which is why a hit is
 * reported with its surface and triaged, never silently ignored).
 */
export function scanText(text: string, canary?: Canary): Hit[] {
  const hits: Hit[] = [];
  if (canary) {
    if (text.includes(canary.marker))
      hits.push({ kind: 'marker', masked: `${canary.marker.slice(0, 9)}…` });
    for (const [name, form] of Object.entries(canary.panForms)) {
      if (text.includes(form)) hits.push({ kind: `form:${name}`, masked: mask(canary.pan) });
    }
  }
  const stripped = text.replace(UUID_RE, '');
  for (const m of stripped.matchAll(GENERIC_RE)) {
    const digits = m[0].replace(/\D/g, '');
    if (digits.length >= 15 && digits.length <= 19 && luhnValid(digits)) {
      hits.push({ kind: 'generic-luhn', masked: mask(digits) });
    }
  }
  return hits;
}

/** scan a JSON-serialisable value: its text form plus its property names */
export function scanValue(value: unknown, canary?: Canary): Hit[] {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  const keyHits: Hit[] = cardKeys(value).map((k) => ({ kind: 'card-key', masked: k }));
  return [...scanText(text ?? '', canary), ...keyHits];
}
