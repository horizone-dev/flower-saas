import type { ErrorDetail } from '../errors/domain-error.js';

/**
 * Validation error details — the ONE place a Zod issue becomes `details[]` in an error response.
 *
 * A Zod issue can carry caller-controlled text: an `unrecognized_keys` message quotes the offending property NAMES, and a
 * `path` segment of a `z.record` / nested object is the caller's own key. Echoing those verbatim reflects whatever the caller
 * typed (for example a payment-card number used as a property name) into the response. Everything here keeps today's exact
 * text for ordinary, identifier-shaped names and replaces anything else, so a legitimate client sees no difference.
 *
 * Every other built-in Zod message is static or derived from the SCHEMA (expected type / enum values / limits), never from
 * the input value; a defensive digit-run mask on the final text covers a future custom message that interpolates input.
 */

export interface ValidationIssueLike {
  readonly code?: string;
  readonly path: readonly PropertyKey[];
  readonly message: string;
  readonly keys?: readonly string[];
}

const REDACTED_KEY = '[redacted]';
const REDACTED_SEGMENT = '*';
const REDACTED_DIGITS = '[digits]';

/** ASCII identifier-shaped name: letters, digits, `_`, `.`, `-`, at most 64 characters, starting with a letter or `_` */
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** a run of 12 or more digits, optionally separated by single spaces / dots / dashes (card-number lengths are 12–19) */
const LONG_DIGITS_RE = /\d(?:[ .-]?\d){11,}/g;

function luhnValid(digits: string): boolean {
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

/** true when `text` contains a digits-only run of 13–19 digits that passes the Luhn check (any window of a longer run) */
function hasCardShapedRun(text: string): boolean {
  for (const run of text.match(/\d{13,}/g) ?? []) {
    for (let len = 13; len <= 19; len++) {
      for (let i = 0; i + len <= run.length; i++) {
        if (luhnValid(run.slice(i, i + len))) return true;
      }
    }
  }
  return false;
}

/**
 * Whether a caller-supplied property name may be echoed back: an ordinary identifier (or a UUID, the key of
 * `perBranchOverlay`) that cannot be a card number or an opaque encoded blob. Non-ASCII names (full-width digits, Arabic-Indic
 * digits, zero-width characters, look-alikes) never match, so they are always replaced.
 */
export function isSafePropertyName(name: string): boolean {
  if (UUID_RE.test(name)) return !hasCardShapedRun(name.replace(/-/g, ''));
  if (!NAME_RE.test(name)) return false;
  if (/\d{4}/.test(name)) return false; // a name never needs a run of four digits; every card number has one
  // a long mixed-case alphanumeric token with digits is an encoded blob (base64 of a number …), not a property name
  if (name.length >= 16 && /\d/.test(name) && /[a-z]/.test(name) && /[A-Z]/.test(name))
    return false;
  return true;
}

function sanitizeSegment(segment: PropertyKey): string {
  if (typeof segment === 'number') return String(segment);
  if (typeof segment === 'string') return isSafePropertyName(segment) ? segment : REDACTED_SEGMENT;
  return REDACTED_SEGMENT; // a symbol key
}

/** the dotted field path, with every non-identifier segment replaced */
export function sanitizeFieldPath(path: readonly PropertyKey[]): string {
  return path.map(sanitizeSegment).join('.');
}

function maskLongDigitRuns(text: string): string {
  const normalized = text.normalize('NFKC'); // so full-width / other-script digits are seen as digits
  const masked = normalized.replace(LONG_DIGITS_RE, REDACTED_DIGITS);
  return masked === normalized ? text : masked; // unchanged text is returned byte for byte, never the normalized copy
}

/** mirrors Zod 4's own wording exactly, with unsafe names replaced */
function unrecognizedKeysMessage(keys: readonly string[]): string {
  const quoted = keys.map((k) => `"${isSafePropertyName(k) ? k : REDACTED_KEY}"`);
  return keys.length === 1
    ? `Unrecognized key: ${quoted[0]}`
    : `Unrecognized keys: ${quoted.join(', ')}`;
}

export function sanitizeIssueMessage(issue: ValidationIssueLike): string {
  const message =
    issue.code === 'unrecognized_keys' && issue.keys !== undefined
      ? issue.keys.every(isSafePropertyName)
        ? issue.message // every name is safe: Zod's own text, byte for byte
        : unrecognizedKeysMessage(issue.keys)
      : issue.message;
  return maskLongDigitRuns(message);
}

/** `details[]` for a `400 VALIDATION_FAILED` response — same shape as before: `{ field, issue }` or `{ issue }` */
export function toValidationDetails(issues: readonly ValidationIssueLike[]): ErrorDetail[] {
  return issues.map((i) => {
    const field = sanitizeFieldPath(i.path);
    const issue = sanitizeIssueMessage(i);
    return field ? { field, issue } : { issue };
  });
}
