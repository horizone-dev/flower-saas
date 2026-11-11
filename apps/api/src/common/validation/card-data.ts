import { Injectable, type ArgumentMetadata, type PipeTransform } from '@nestjs/common';
import { DomainError } from '../errors/domain-error.js';

/**
 * Task 3b.11 finding F3 — free-text storage. A payment card number must never be stored in this system (HG3b-PCI, CLAUDE.md
 * §6). Structured request fields are validated by their schemas, but a FREE-TEXT field (a note, a reason, a description, a name)
 * accepts any text — so a card number typed there would be persisted, audited and returned. This pipe refuses it at the door.
 *
 * Scope is deliberately narrow so legitimate data is never rejected:
 *  - only string values under a free-text-NAMED key are checked (a key CONTAINING note / reason / description / memo / comment /
 *    remark / narrative / message / address / name / label / title / text / detail), and never a key that ENDS in an identifier-like
 *    word (id, code, number, ref, reference, sku, barcode, trn, iban, phone, email, slug, key, token, secret, password, amount, qty,
 *    price, total) — barcodes, SKUs, phones, TRNs, bank references, ids and amounts legitimately contain long digit runs;
 *  - a value is rejected only when it holds a WHOLE digit run of 13–19 digits that passes the Luhn check and is not one repeated
 *    digit — the shape of a real card number. Digits may be separated by single spaces, dashes, dots or underscores.
 * Disguises are folded away first (see {@link normaliseForCardScan}): full-width and Arabic-Indic digits, zero-width characters.
 * A Luhn-valid number in a note IS refused even if it was meant as an order reference; the message says why. This is a guard
 * against accidental and casual entry, not a proof of absence: a number split across two fields or written in words is not detected.
 */
const FREE_TEXT_KEY_RE =
  /(notes?|reason|description|memo|comment|remark|narrative|message|address|name|label|title|text|detail)/i;
const NOT_FREE_TEXT_KEY_RE =
  /(id|ids|code|number|no|ref|reference|sku|barcode|qr|trn|iban|phone|email|slug|key|token|secret|password|amount|qty|quantity|price|total)$/i;
const DIGIT_RUN_RE = /\d(?:[\s.\-_]?\d){12,}/g;
const SEPARATOR_RE = /[\s.\-_]/g;
const MAX_DEPTH = 12;
const MAX_NODES = 5000;

function luhn(digits: string): boolean {
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

/**
 * Normalise text so that a card number cannot be disguised: Unicode compatibility folding (full-width digits → ASCII), the
 * Arabic-Indic (U+0660–0669) and Extended Arabic-Indic (U+06F0–06F9) digits used across the GCC, and removal of zero-width /
 * soft-hyphen / bidirectional-control characters that split a digit run invisibly.
 */
export function normaliseForCardScan(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/[\u200b-\u200f\u2060\ufeff\u00ad\u202a-\u202e]/g, '')
    .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[\u06f0-\u06f9]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
}

/**
 * true when `text` contains a WHOLE digit run (single separators allowed between digits) of 13–19 digits that passes the Luhn check
 * and is not one repeated digit. Windows inside a longer run are NOT tried: every long run contains some Luhn-valid window, which
 * would reject ordinary long numbers.
 */
export function containsCardNumber(raw: string): boolean {
  const text = normaliseForCardScan(raw);
  for (const m of text.matchAll(DIGIT_RUN_RE)) {
    const digits = m[0].replace(SEPARATOR_RE, '');
    if (digits.length < 13 || digits.length > 19) continue;
    if (/^(\d)\1*$/.test(digits)) continue;
    if (luhn(digits)) return true;
  }
  return false;
}

/** whether a request-body key is treated as a free-text field */
export function isFreeTextKey(key: string): boolean {
  return FREE_TEXT_KEY_RE.test(key) && !NOT_FREE_TEXT_KEY_RE.test(key);
}

@Injectable()
export class FreeTextCardGuardPipe implements PipeTransform {
  transform(value: unknown, metadata: ArgumentMetadata): unknown {
    if (metadata.type !== 'body' || value === null || typeof value !== 'object') return value;
    let nodes = 0;
    const walk = (v: unknown, key: string | null, depth: number): void => {
      if (depth > MAX_DEPTH || ++nodes > MAX_NODES) return;
      if (typeof v === 'string') {
        if (key !== null && isFreeTextKey(key) && containsCardNumber(v)) {
          throw new DomainError(
            'SENSITIVE_DATA_REJECTED',
            'free-text fields must not contain a payment card number',
            400,
            // the key name is the CALLER's text: echo it only when it is a plain letters-only identifier, never a digit run
            [
              {
                field: /^[A-Za-z_]{1,64}$/.test(key) ? key : '[redacted]',
                issue: 'must not contain a payment card number',
              },
            ],
          );
        }
        return;
      }
      if (Array.isArray(v)) {
        for (const item of v) walk(item, key, depth + 1);
        return;
      }
      if (v !== null && typeof v === 'object') {
        for (const [k, x] of Object.entries(v as Record<string, unknown>)) walk(x, k, depth + 1);
      }
    };
    walk(value, null, 0);
    return value;
  }
}
