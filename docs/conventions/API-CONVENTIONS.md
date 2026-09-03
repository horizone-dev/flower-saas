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

## Concurrency

- Aggregates with a `version` column (Order, BranchInventoryBalance) use optimistic
  concurrency: send `If-Match: <version>` or a body `version`; a mismatch is 409.

## Realtime

- Not REST. Clients open a WebSocket to the `realtime` gateway with their access
  token, then `subscribe` — the gateway assigns topics from the session. Clients
  send `last_seq` per topic on reconnect for replay. See ADR-0009.

## Conventions for money, quantities, dates

- Money on the wire: `{ "amountMinor": 100500, "currency": "KWD", "exponent": 3 }`.
- Quantities: string-encoded decimals in the item's base UOM (avoid float in JSON).
- Timestamps: RFC 3339 UTC (`2026-09-03T08:25:05Z`). Scheduled/local times also
  carry an IANA timezone.
