import fastify from 'fastify';
import type { FastifyInstance, FastifyRequest } from 'fastify';

const { FST_ERR_CTP_EMPTY_JSON_BODY, FST_ERR_CTP_INVALID_JSON_BODY } = fastify.errorCodes;

/** A property this module stashes on the raw Fastify request — read it via
 *  `getRawBody(request)`, never `request['rawBody']` directly. */
const RAW_BODY_SYMBOL = Symbol('flower:rawBody');

interface WithRawBody {
  [RAW_BODY_SYMBOL]?: Buffer;
}

/**
 * Task 3b.5 Checkpoint F — the smallest repository-consistent raw-body
 * mechanism (owner §F4). Inspected first: no raw-body support existed
 * anywhere in this bootstrap before this checkpoint (no `fastify-raw-body`
 * or equivalent dependency, no existing content-type-parser override).
 *
 * Overrides Fastify's DEFAULT `application/json` content-type parser to
 * additionally stash the exact raw bytes it received, alongside performing
 * the EXACT SAME `JSON.parse` Fastify's own default parser would have done
 * — every existing route's `request.body` behavior is completely
 * unchanged; this only ADDS a way to retrieve the original bytes via
 * {@link getRawBody}. The webhook signature-verification path
 * (`payment-webhook.controller.ts`) is the ONLY caller of `getRawBody` — no
 * other route in this codebase needs it, and none is required to.
 *
 * Mirrors `installRequestContext`'s own convention exactly: a plain
 * function taking the raw Fastify instance, called once from `main.ts` AND
 * from every integration test's own bootstrap (tests build their own
 * `NestFastifyApplication`, so they must call this too — see
 * `payment-webhook.controller.integration.test.ts`).
 *
 * MUST be called AFTER `app.init()` (or `app.listen()`, which calls `init()`
 * internally) — Nest's `FastifyAdapter` registers ITS OWN default
 * `application/json` parser lazily, during `init()`, not at adapter
 * construction time. Calling this before `init()` means Nest's own
 * registration runs second and Fastify throws
 * ("Content type parser 'application/json' already present") — discovered
 * directly while wiring this up, not assumed. Removing the existing parser
 * first (defensively — it may or may not exist yet depending on call order)
 * makes this call safe regardless.
 */
export function installRawBodyCapture(instance: FastifyInstance): void {
  try {
    instance.removeContentTypeParser('application/json');
  } catch {
    // not yet registered — fine, we're about to add it.
  }
  instance.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (request, rawBody, done) => {
      // `parseAs: 'buffer'` above guarantees this is always a Buffer at
      // runtime; the shared overload's type is wider (`string | Buffer`).
      const body = rawBody as Buffer;
      (request as unknown as WithRawBody)[RAW_BODY_SYMBOL] = body;
      if (body.length === 0) {
        // Fastify's own default JSON parser (`getDefaultJsonParser` in
        // `fastify/lib/content-type-parser.js`) treats an empty body as an
        // error too, not as `undefined` — a genuine mismatch caught
        // directly by inspecting that source (this module originally
        // guessed `undefined`, which is wrong): replicate it exactly with
        // the SAME public error class.
        done(new FST_ERR_CTP_EMPTY_JSON_BODY(), undefined);
        return;
      }
      try {
        done(null, JSON.parse(body.toString('utf8')));
      } catch {
        // Fastify's own default parser wraps a parse failure in this SAME
        // public `@fastify/error`-based class (never a plain `Error`) —
        // that class itself carries the correct `statusCode`/`code`, which
        // is what actually makes Nest's request lifecycle short-circuit to
        // a 400 before reaching `AllExceptionsFilter`'s generic 500 path.
        // A genuine regression was caught here directly (a permanent test
        // in `payment-webhook.controller.integration.test.ts` proves it):
        // a plain `Error` with a bolted-on `.statusCode` was NOT enough —
        // only the real Fastify error class works.
        done(new FST_ERR_CTP_INVALID_JSON_BODY(), undefined);
      }
    },
  );
}

/**
 * The exact raw bytes Fastify received for this request, byte-for-byte —
 * never a re-stringified reconstruction of `request.body` (owner §F4: a
 * signature check over a re-serialized JSON object can disagree with the
 * provider's own signature over its original bytes, e.g. differing key
 * order/whitespace). `undefined` if {@link installRawBodyCapture} was never
 * installed, or the request body was empty.
 */
export function getRawBody(request: FastifyRequest): Buffer | undefined {
  return (request as unknown as WithRawBody)[RAW_BODY_SYMBOL];
}
