# PROPOSAL — offline-queued financial operations: what is safe today, what needs an owner policy

- **Status:** **PROPOSAL / analysis. No offline acceptance policy is implemented or invented.** Prepared with B5.7 (2026-11-12).
- **Related:** [ADR-0022](ADR-0022.md) (D15, B5.5–B5.7 notes), CLAUDE.md rules 8, 30, 31 (Z-6), `operation-proof.integration.test.ts`.

## 1. What is already decided

- **Rule 31 / Z-6:** financial and inventory-changing sales are **online-only for v1**. Class C operations (any inventory / reservation write,
  provider payments, refunds, credit, adjustments, Z finalise, role / secret changes, online-order actions) are **hard-blocked offline**.
  Controlled offline cash sale (**Class B**) is "architecture-ready" behind a tenant flag and may be implemented **only after a separately
  approved** conflict / numbering / reservation / idempotency / reconciliation model.
- **ADR-0022 D15:** device activation and every device proof are online acts (Class C).

So the POS may cache UI, read-only and low-risk reference data for a temporary network loss; it may **not** book a financial effect offline.

## 2. What the B5.7 mechanism gives, independent of any offline policy

A client that holds a queue of requests it could not send must, **on reconnect**, follow this protocol. Each step is enforced by the server;
none of it decides whether a _stale_ request should be honoured.

| Step                                                                                                                                                                                                             | Server-enforced property (tested on real PostgreSQL + Redis)                                                                                                     |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Authenticate again. If the session is gone, log in with credentials **and a fresh device session proof**; if it is alive, refresh it (a bound session's refresh requires a proof)                             | an expired session, a revoked / blocked / replaced device, or a proof from another device cannot continue; the access token is ≤ 10 min                          |
| 2. For **each** queued request fetch a fresh server nonce (`POST /v1/devices/challenge`, purpose `op`) and sign **that** request: method, exact path, SHA-256 of the exact body bytes, SHA-256 of the session id | a proof signed ahead of time is dead on arrival (the nonce is 60 s of **server** time); a proof cannot be moved to another body, path, method, session or device |
| 3. Send the request with its **original `Idempotency-Key`**                                                                                                                                                      | the handler runs at most once per key even if the client crashed before it recorded the answer; a retry gets the stored answer                                   |
| 4. A failure leaves the other requests untouched; resume with new proofs and the same keys                                                                                                                       | every effect exactly once; no proof is ever reused; a failed request burns its proof (a retry signs another)                                                     |

Consequences the owner should know: **operation proofs cannot be pre-signed** (so they cannot authenticate work done while offline —
that is a feature of D15, not a gap); a device revoked or blocked while offline loses its whole queue **on arrival** (nothing executes);
two sessions of the same user syncing the same queue execute each request once (the idempotency identity is tenant + operation + user + key).

## 3. What B5.7 deliberately does NOT do

No batch / sync endpoint; no "offline acceptance window"; no rule about prices, tax, stock, numbering or ordering of a request whose real-world
time is earlier than its arrival; no quarantine store for refused requests; no tenant flag. Each of those is a **policy** the owner has not set.

## 4. Decisions needed before any offline financial capture (Class B)

1. **Scope:** is any offline financial capture wanted at all? Which operations (cash walk-in sale only?) and for which tenants (flag)?
2. **Acceptance window:** the maximum age of a queued request at arrival (today: the session and proof lifetimes make anything older than a
   re-login impossible to send as-is). Is a sale booked at **sale time** or at **sync time** (tax rate, price list, shift / period, Z-report)?
3. **Price, tax and stock:** who bears a price change or an out-of-stock between sale and sync (the store honours the price shown to the customer?
   reconcile as a variance?). Rule 24 (no stock consumption on cart) interacts with local reservation.
4. **Document numbering:** gapless invoice numbers cannot be assigned offline. Provisional local numbers and a mapping at sync, or reserved number blocks per terminal?
5. **Revoked / blocked / replaced device with a queue:** today the whole queue is refused (fail closed). The customer may already have paid cash —
   is there a **quarantine for Owner review** (a read-only record, never executed automatically), and who may release it?
6. **Replacement:** may a replacement device re-sign the old device's queued requests? (The server cannot tell; it would accept them as new signed
   operations.) The safe default is **no** — which needs a rule and, probably, a quarantine as in 5.
7. **Evidence:** should the device sign each request **at capture time** (a _capture signature_, distinct from the online proof) so the server can show
   when and on which device a request was made? It would need its own purpose and clock policy.
8. **Time of sale:** server timestamps vs device timestamps; a mis-clocked tablet must not move a sale across a closed period (period close is Z-report territory).
9. **Local data:** what the PWA wipes when it learns it was revoked at reconnect, and a maximum queue size / retention.
10. **Duplicate semantics across devices:** the same key from two devices of the same user is one request (by design); is that wanted for cash sales?

## 5. Recommendation

Keep rule 31 for v1 (no offline financial capture). Treat items 1–10 as the input of a **separate ADR** for Class B, to be approved before any
code. Until then the B5.7 mechanism is safe to ship as an opt-in capability that no production route uses.
