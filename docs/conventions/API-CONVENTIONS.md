# API conventions

## Surface

- REST under **`/v1`** (path-versioned). One OpenAPI document generated from the
  NestJS decorators; `packages/api-client` is generated from it.
- JSON only. `snake_case` is **not** used on the wire — request/response bodies are
  `camelCase`; the DB is `snake_case`; the mapping happens in repositories.
- Self-service staff endpoints live under **`/v1/me/*`** (POS PWA is the only
  consumer).
- Attendance connector ingest: **`POST /v1/attendance/ingest`** (HMAC-signed).
- Provider webhooks: `POST /v1/webhooks/{provider}` (per-provider, signature +
  timestamp/replay verified, raw body stored, processed async).

## Auth headers

- `Authorization: Bearer <access token>` — short-lived; the server-side session is
  the revocation point.
- Registered POS devices additionally send a device proof header (challenge/response
  signature) on login/refresh.
- **Scope is never sent by the client.** `tenant_id` / `branch_id` come from the
  session. A body/param/header that tries to set scope is ignored (and flagged).

## Errors — one envelope

```json
{
  "error": {
    "code": "ORDER_NOT_FOUND",
    "message": "Human-readable, safe to display",
    "details": [{ "field": "lineItems[0].quantity", "issue": "must be > 0" }],
    "correlationId": "01J..."
  }
}
```

- `code` is a stable machine string from a registry. HTTP status matches semantics
  (400 validation, 401 auth, 403 permission/scope, 404 not-found-or-not-visible,
  409 conflict/idempotency, 422 business-rule, 429 rate-limit, 5xx server).
- **Cross-tenant / cross-branch access returns 403 or 404** (never leaks existence
  differently) — the probe suite asserts this.

### Correlation id

Each request carries a correlation id, used to trace one request across its response and the server's log lines. A client
**may** suggest one in the `x-correlation-id` request header; the server uses it only if it passes the checks below,
otherwise it generates its own (a UUID v4) and says nothing about the substitution.

**Where it appears**

- The `x-correlation-id` response header, on responses to requests the server routes — including 404s, request-body
  parse errors and 5xx responses. A request whose URL the HTTP layer rejects before routing (for example an invalid
  percent-escape such as `/%E0%A4%A`) receives its 400 **without** the header.
- `error.correlationId` in error envelopes produced by the application's exception filter, and that filter's log line.
- It is not stored on audit rows.
- The API does not send `Access-Control-Expose-Headers`, so a script running on a different origin cannot read the
  response header; it can read `error.correlationId` from an error body instead.

**Accepted from a client** (case-insensitive; anything else is replaced)

- a **UUID**: 8-4-4-4-12 hexadecimal digits separated by hyphens. The digits are not checked for version or variant;
- a **ULID**: exactly 26 characters from `0-9` and `A-Z` excluding `I`, `L`, `O` and `U`. The timestamp range (leading
  character `7` or lower) is not checked.

**Card-shaped check.** An id in one of those formats is still replaced if it looks like it could contain a payment card
number: the hyphens are removed, and every substring of 13–19 digits taken from any run of 13 or more consecutive digits
is tested with the Luhn check; one passing substring is enough. This is a heuristic safeguard, not a guarantee that no
card data can appear in any encoding — the restriction to the two formats above is the primary control. It also replaces
some legitimate ids: about 0.7 % of random v4 UUIDs (14,781 of 2,000,000 measured), a far smaller share of ULIDs, and the
nil UUID `00000000-0000-0000-0000-000000000000`.

**Replaced, not honoured:** any other value — an unhyphenated or braced UUID, `urn:uuid:…`, a W3C trace id, a custom or
numeric id (`req-…`, Snowflake, epoch milliseconds), a value longer than 36 characters, one containing whitespace, CR/LF
or encoded text, a repeated header, or a non-string. The rejected value is not echoed in the response or written to the
application's own log lines, and no error is returned. A client therefore cannot assume its suggested id was kept.

**Not read:** `x-request-id`, `traceparent` and `tracestate` are ignored entirely.

## Pagination

- Cursor-based: `?limit=<n>&cursor=<opaque>`. Response:
  `{ "data": [...], "pageInfo": { "nextCursor": "...", "hasNextPage": true } }`.
- `limit` default 25, max 100. List endpoints **always** inject the tenant + branch
  scope filter server-side.

## Idempotency

- `Idempotency-Key: <uuid>` **required** on every state-changing external-facing
  request (sales, payments, receiving, refunds, adjustments, ingest, webhook
  processing). The server stores `(key, scope, request_hash, response_snapshot,
expires_at)`; a repeat with the same key + hash returns the stored response; a
  repeat with a different hash is a 409.
- **Structural vs semantic validation.** A malformed request shape (missing /
  wrong-typed field, unknown body key, an out-of-bounds array length) is a
  **`400`** from the request schema. A **semantic / domain** violation on a
  structurally-valid payload (a duplicate identity in a bulk set, a currency that
  disagrees with an authoritative reference, a value that breaks a business rule)
  is a **typed `DomainError`** raised by the controller/service **after** the
  parse — `422` for a business-rule violation, `400` only for a canonical-form
  requirement (e.g. "entries must be sorted"). A bulk-write client MAY sort
  entries into canonical order for transport but MUST NOT silently de-duplicate —
  a duplicate is surfaced (client-side error before the call, or the server's
  authoritative `422`), never collapsed to one arbitrary value. Task 3.8's branch
  availability bulk `PUT` is the reference: `structuralSetBranchAvailabilitySchema`
  → `400`; `duplicateVariantIds` → `422 BRANCH_AVAILABILITY_DUPLICATE_VARIANT`.

## Concurrency

- Aggregates with a `version` column (Order, BranchInventoryBalance) use optimistic
  concurrency: send `If-Match: <version>` or a body `version`; a mismatch is 409.

## Realtime

- Not REST. Clients open a WebSocket to the `realtime` gateway with their access
  token, then `subscribe` — the gateway assigns topics from the session. Clients
  send `last_seq` per topic on reconnect for replay. See ADR-0009.

## Conventions for money, quantities, dates

- Money on the wire: `{ "amountMinor": "100500", "currency": "KWD", "exponent": 3 }`.
  `amountMinor` is an **integer string**, never a JSON number — a `number`
  cannot safely carry the full minor-unit range and "no binary floating point
  for money" (ADR-0006) rules it out on the wire too. `exponent` must equal the
  currency's canonical exponent. The `moneyDtoSchema` in `@flower/money`
  (re-exported from `@flower/shared-types`) is the authoritative validator.
- Quantities on the wire: `{ "amount": "1.5000" }` — a decimal string with at
  most 4 fractional places, in the item's base UOM (avoid float in JSON). The
  UOM code travels alongside in the payload, not inside the value.
  `quantityDtoSchema` in `@flower/uom` is the validator.
- Timestamps: RFC 3339 UTC (`2026-09-03T08:25:05Z`). Scheduled/local times also
  carry an IANA timezone.
