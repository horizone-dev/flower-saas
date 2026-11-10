/**
 * Safe message templating — the text half of the allowlist-first design.
 *
 * Free text that reaches a log line can carry caller-controlled values (a validation error quoting the offending input,
 * an interpolated domain message, a database error echoing a rejected value). Rather than try to recognise every
 * sensitive value, the template keeps only the STRUCTURE of the sentence and replaces the places a value usually sits:
 *
 *   - quoted spans ("…", '…', `…`)            → "…"
 *   - e-mail addresses                          → <email>
 *   - long opaque tokens (keys, JWTs, base64)   → <token>
 *   - runs of six or more digits (any script)   → #
 *
 * It does NOT claim to remove every possible secret: an unquoted, short, free-text value interpolated into a sentence
 * survives. That is why error OBJECTS are serialized from an allowlist of structured fields (see `safe-error.ts`) and this
 * template is only the fallback for the one free-text field that remains (the message).
 */

const ZERO_WIDTH_RE = new RegExp('[\\u200b-\\u200d\\u2060\\ufeff]', 'g');
const DOUBLE_QUOTED_RE = /"[^"\n]{0,300}"/g;
const BACKTICKED_RE = /`[^`\n]{0,300}`/g;
/** a quote pair that is not an apostrophe inside a word ("can't", "o'clock") */
const SINGLE_QUOTED_RE = /(^|[^\p{L}\p{N}])'[^'\n]{1,300}'(?![\p{L}\p{N}])/gu;
const EMAIL_RE = /[^\s@"'<>]+@[^\s@"'<>]+\.[^\s@"'<>]+/g;
const OPAQUE_TOKEN_RE = /[A-Za-z0-9+/_=-]{24,}/g;
/** six or more decimal digits of ANY script, optionally separated by single spaces / dots / dashes / underscores */
const DIGIT_RUN_RE = /\p{Nd}(?:[ ._-]?\p{Nd}){5,}/gu;

export const TEMPLATE_MAX_LENGTH = 240;

/** the first line of a text (error messages are often multi-line: source excerpts, argument dumps) */
export function firstLine(text: string): string {
  const i = text.search(/[\r\n]/);
  return i === -1 ? text : text.slice(0, i);
}

/** the structure of a message with its value-bearing spans replaced; bounded in length */
export function templateText(input: string, maxLength = TEMPLATE_MAX_LENGTH): string {
  const folded = input.normalize('NFKC').replace(ZERO_WIDTH_RE, '');
  const templated = folded
    .replace(DOUBLE_QUOTED_RE, '"…"')
    .replace(BACKTICKED_RE, '`…`')
    .replace(SINGLE_QUOTED_RE, "$1'…'")
    .replace(EMAIL_RE, '<email>')
    .replace(OPAQUE_TOKEN_RE, '<token>')
    .replace(DIGIT_RUN_RE, '#');
  return templated.length > maxLength ? `${templated.slice(0, maxLength)}…` : templated;
}

/** the message argument of a log call: a developer-written sentence, possibly with an interpolated application message */
export function sanitizeLogMessage(message: string): string {
  return templateText(message);
}
