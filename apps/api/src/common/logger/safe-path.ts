/**
 * Safe request path for application logs.
 *
 * `request.url` is the raw request target: pathname + query string (+ fragment on some clients). A query string is
 * caller-controlled free text — it can carry a payment-card number, a token or any other secret — and a path segment can too
 * (an unmatched route logs whatever the caller typed). Logging it verbatim writes that text to every log sink.
 *
 * `safePath` returns the pathname only and masks card-shaped digit runs inside it. For ordinary application paths (UUIDs,
 * slugs, the `/v1/...` route tree) the result is BYTE-IDENTICAL to the pathname, so log search and dashboards keyed on `path`
 * keep working; the matched route PATTERN (`/v1/companies/:companyId/...`) is logged separately by the caller.
 *
 * Bounded by design: it recognises digit runs of 12 or more (optionally separated by single spaces, dots, dashes or
 * underscores, after percent-decoding, Unicode compatibility folding and removal of zero-width characters) and a UUID-shaped
 * segment that hides a Luhn-valid card number. It does not claim to detect a card number disguised some other way (encoded,
 * split across segments, written with letters).
 */

const MASKED_DIGITS = '[digits]';
const MASKED_SEGMENT = '[masked]';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** a run of 12+ decimal digits of ANY script (ASCII, full-width, Arabic-Indic …) with single separators between them (card numbers are 12–19 digits) */
const LONG_DIGITS_RE = /\p{Nd}(?:[ ._-]?\p{Nd}){11,}/gu;
const ZERO_WIDTH_RE = new RegExp('[\u200b-\u200d\u2060\ufeff]', 'g');

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

function hasLuhnRun(digitsOnlyText: string): boolean {
  for (const run of digitsOnlyText.match(/\d{13,}/g) ?? []) {
    for (let len = 13; len <= 19; len++) {
      for (let i = 0; i + len <= run.length; i++) {
        if (luhnValid(run.slice(i, i + len))) return true;
      }
    }
  }
  return false;
}

function decode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment; // a malformed escape: judge the raw text
  }
}

function sanitizeSegment(segment: string): string {
  const folded = decode(segment).normalize('NFKC').replace(ZERO_WIDTH_RE, '');
  if (UUID_RE.test(folded)) return hasLuhnRun(folded.replace(/-/g, '')) ? MASKED_SEGMENT : segment;
  const masked = folded.replace(LONG_DIGITS_RE, MASKED_DIGITS);
  return masked === folded ? segment : masked; // an untouched segment is returned exactly as received
}

/** the request path for a log line: no query string, no fragment, card-shaped digit runs masked */
export function safePath(url: string | undefined): string {
  if (!url) return '';
  const cut = url.search(/[?#]/);
  const pathname = cut === -1 ? url : url.slice(0, cut);
  return pathname.split('/').map(sanitizeSegment).join('/');
}
