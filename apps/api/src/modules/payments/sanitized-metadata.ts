/**
 * Task 3b.5 Checkpoint F — bounded, JSON-primitive-only shape guard for an
 * adapter's `sanitizedMetadata` (owner §F29). Pure. Business capture logic
 * NEVER reads this — it exists purely as informational, size-bounded
 * context for a human/operator. Rejects (throws `RangeError`, matching this
 * repository's pure-module error convention) an oversized payload or a
 * disallowed key that would suggest a raw header/secret/PAN/CVV leaked in.
 */
const MAX_BYTES = 4096;
// owner Checkpoint G §G23 adversarial pass — `cardNumber`/`card_number`/
// `card-number` added: the original F-era pattern rejected `pan` but not
// the equally common `cardNumber` shape, a genuine gap found and closed
// directly by that requirement's own test, not by inspection alone.
const FORBIDDEN_KEY_RE =
  /(pan|card[-_]?number|cvv|cvc|api[-_]?key|secret|signature|authoriz(a|e)tion)/i;

// owner Checkpoint G proof pass §4 — a genuine gap found directly by that
// requirement's own test, not by inspection: the original guard only
// checked TOP-LEVEL keys. Nested objects/arrays were never rejected and
// never walked, so `{ card: { cardNumber: "..." } }` passed straight
// through — the top-level key "card" doesn't match `FORBIDDEN_KEY_RE`, and
// nothing ever looked one level deeper. CASE B applies (nested
// objects/arrays ARE accepted by the actual shape check above — only `null`
// / non-object / array-at-the-TOP-LEVEL is rejected, per owner §F29's
// "plain JSON object" contract), so per the proof pass's own instruction
// the fix is to make key-filtering recursive, not to newly reject nesting
// outright (that would be a materially different, undocumented contract
// change). Every key at every depth, inside nested objects AND inside
// arrays of objects, is now checked.
function walkForForbiddenKeys(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) walkForForbiddenKeys(item);
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if (FORBIDDEN_KEY_RE.test(key)) {
        throw new RangeError(
          `sanitizedMetadata key "${key}" looks like sensitive content — rejected`,
        );
      }
      walkForForbiddenKeys(nested);
    }
  }
}

export function assertSanitizedMetadataShape(
  value: unknown,
): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new RangeError('sanitizedMetadata must be a plain JSON object');
  }
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json, 'utf8') > MAX_BYTES) {
    throw new RangeError(`sanitizedMetadata exceeds the ${MAX_BYTES}-byte bound`);
  }
  walkForForbiddenKeys(value);
}
