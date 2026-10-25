import type { FastifyInstance } from 'fastify';

/**
 * Inbound `x-correlation-id` handling (task 3b.11, PCI finding).
 *
 * A caller-supplied correlation id reaches the response header + body, the exception-filter log line, the request
 * context (and from there audit rows). It is therefore an INPUT that must be a safe, canonical identifier — never an
 * arbitrary string (a card number would otherwise be logged, echoed and stored).
 *
 * Accepted (the only formats this system generates or documents):
 *   - a hyphenated UUID  (Fastify `genReqId` = `randomUUID()`; any version)
 *   - a ULID             (26 Crockford base32 characters; the example in API-CONVENTIONS)
 * and, in both cases, NOT card-shaped: after separators are removed, no 13–19 digit window of a digit run may pass the Luhn
 * check (that is a payment card number). Luhn — not "any 13+ digit run" — keeps ordinary random UUIDs (≈2 % of which
 * contain a long digit run) accepted, so legitimate ids keep their traceability.
 *
 * Anything else — a duplicated header, a non-string, a numeric/PAN-shaped value, an encoded or oversized value — is
 * DISCARDED (never echoed, never logged) and replaced by the server-generated id.
 */
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const ULID_RE = /^[0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{26}$/;

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

/** true when any 13–19 digit window of a digit run is Luhn-valid (i.e. could be a payment card number) */
function hasCardShapedDigits(id: string): boolean {
  for (const run of id.replace(/-/g, '').match(/\d{13,}/g) ?? []) {
    for (let len = 13; len <= 19; len++) {
      for (let i = 0; i + len <= run.length; i++) if (luhnValid(run.slice(i, i + len))) return true;
    }
  }
  return false;
}

export function isSafeCorrelationId(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 36) return false;
  if (!UUID_RE.test(value) && !ULID_RE.test(value)) return false;
  return !hasCardShapedDigits(value);
}

/** the inbound value when it is a safe canonical id, else the server-generated one (which is always safe) */
export function resolveCorrelationId(inbound: unknown, generated: string): string {
  return isSafeCorrelationId(inbound) ? inbound : generated;
}

export const CORRELATION_HEADER = 'x-correlation-id';

/** Fastify `onRequest` hook: sets `request.correlationId` and the response header from a SAFE value only. */
export function installCorrelationId(fastify: FastifyInstance): void {
  fastify.addHook('onRequest', (request, reply, done) => {
    const correlationId = resolveCorrelationId(
      request.headers[CORRELATION_HEADER],
      String(request.id),
    );
    (request as { correlationId?: string }).correlationId = correlationId;
    void reply.header(CORRELATION_HEADER, correlationId);
    done();
  });
}
