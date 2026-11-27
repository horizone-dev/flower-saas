# PROPOSAL — POS-only mandatory registered-device enforcement for the 12 Phase 3 money routes

- **Status:** **PROPOSAL for owner decision. Nothing here is implemented, approved or migrated.** Prepared with B5.6 (2026-11-12).
- **Related:** [ADR-0022](ADR-0022.md) (D7, B5.5 notes), `apps/api/src/modules/device-session/device-protection.policy.ts`.

## 1. Where we are (verified)

B5.5 ships a guard with three tiers. The twelve existing money routes (order create / update / hold / resume / cancel, `complete-sale`,
payment-attempts, payments, customer receipts, advance application, advance from-payment, advance refunds) are **VERIFY_IF_BOUND**: a
bound session is checked against the device's live registration on every request; an **unbound** session proceeds exactly as before.
Unbound sessions are what Owner Web, Admin Web and any POS that does not (yet) present a device proof use. Today therefore **a POS
cashier who simply logs in without a device proof can still sell** — by design, because the routes and permissions are shared with
Owner Web and are frozen Phase 3 contracts.

## 2. What "POS-only" must mean (constraints)

1. It must be decided from **server-side facts**, never from anything the client sends. **No header, query value, cookie, body field,
   User-Agent or "channel" claim may relax or select enforcement** (a client could simply omit or forge it). The only client input that
   matters is the proof, and it can only ever _add_ assurance.
2. Owner Web and Admin Web (accounts that are not POS operators) must keep working unchanged, including on the same routes.
3. A frozen Phase 3 controller, route, permission key, response or posting must not change.
4. Fail-closed, tenant-isolated, step-up and audit rules of B5.1–B5.6 are unchanged.
5. Offline-first: nothing in the proposal needs connectivity beyond the request that is already being made (D15, rule 31).

## 3. Options

| Option                                                                                                                                                                        | How "POS operator" is decided (server-side)                                                                  | Frozen files                                         | Migration                                                                                   | Verdict                                                                                                                                                                                                                  |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **A. Tenant switch only** — one flag turns the six money keys into REQUIRED for **every** non-Owner session                                                                   | the tenant's own policy                                                                                      | none                                                 | a writable setting (the existing `registered_device_required` is deliberately non-writable) | Blunt: stops every non-Owner back-office user from using those routes (e.g. a manager keying a sale from Admin Web). Not POS-only.                                                                                       |
| **B. New POS-only permission keys** (e.g. `pos:sell`)                                                                                                                         | the role holds the key                                                                                       | **yes** — the 12 controllers would change their keys | permission registry + role backfill (S0b)                                                   | Cleanest model, but amends frozen Phase 3 routes. Not recommended now.                                                                                                                                                   |
| **C. Role attribute `deviceRequired`** — a system/custom role can be flagged "POS operator role"; a session is a **POS-operator session** when _any_ role it holds is flagged | role data in PostgreSQL, resolved into the session's access snapshot at login/refresh (never from a request) | none (guard + policy only)                           | one nullable/boolean column on `role` + snapshot field (S0-authorised migration)            | **Recommended.** Server-derived, per-role, reversible, does not touch Phase 3 routes.                                                                                                                                    |
| **D. A new POS-only route family** (`/pos/...` in the cash-register family, REQUIRED by prefix) wrapping the same domain services                                             | the route itself                                                                                             | none (additive)                                      | none                                                                                        | Strong and simple, and the right home for cash-register routes anyway; but it needs a second route set and a PWA change. Good as the **end state**, not a substitute for C while the PWA still calls the Phase 3 routes. |

## 4. Recommended design (C now, D as the cash-register routes arrive)

1. **Data.** `role.deviceRequired boolean NOT NULL DEFAULT false` (migration M55, S0-authorised, additive; S0b baseline unaffected — no
   permission is added). Setting it is an Owner + step-up action (a new audited route), never a Manager action; the Owner system role and
   `accountType = OWNER` can never be flagged.
2. **Snapshot.** `PolicyService.resolveForUser` adds `deviceRequired = roles.some(r => r.deviceRequired)` to the access snapshot
   (`SessionData.access`) — a read of data the server already owns, re-resolved at every refresh. (Adding a member to the shared session
   type is an additive change that needs the same approval as the B5.4 record placement — see decision 3.)
3. **Policy (pure, in `device-protection.policy.ts`).** the six money keys are **REQUIRED when the caller is a POS-operator session**,
   VERIFY_IF_BOUND otherwise. The classification gains one input, `callerRequiresDevice`, read from the context built from the session —
   _never_ from the request. The existing precedence is unchanged (public / platform → NONE; family or decorator → REQUIRED).
4. **Enforcement point.** unchanged: `RegisteredTerminalGuard`, after authentication and permission. An unbound POS-operator session is refused with the
   same `403 DEVICE_REQUIRED`; a bound one is verified against the live row exactly as today.
5. **No bypass surface.** The proposal adds **no** header, query value, cookie or body field. Structural pins would forbid the guard and
   policy from reading any request member (the B5.5 pin already does), and a test would send every plausible "I am Owner Web" signal
   (`X-Client`, `X-Auth-Transport`, `Origin`, `User-Agent`, a cookie, `?channel=`) with an unbound POS-operator session and expect 403.
6. **Rollout (no outage).**
   1. ship the guard change with the flag **OFF for every role** (no behaviour change);
   2. **observe mode** — for flagged roles, record `DEVICE_WOULD_HAVE_BEEN_REQUIRED` security events without refusing (measures how many POS
      sessions are still unbound before switching anything);
   3. enforce per tenant, role by role, after the PWA release that presents the device proof (B5.9) is in the field;
   4. Owner break-glass: Owner Web (unbound OWNER account) is never flagged, so a tenant can always un-flag a role.
7. **Offline.** A POS-operator session still needs one online proof to log in; once the PWA holds a valid bound session it queues work
   locally exactly as today, and every queued request is authenticated on arrival (B5.5/B5.6 offline notes). What changes is only that an
   **unbound** session can no longer submit money requests — which is the point.

## 5. Tests the change would require

Unit (policy table incl. the new input, exhaustive); HTTP on real PostgreSQL + Redis: flagged role unbound → 403 on all 12 routes; flagged
role bound → allowed; unflagged role unbound → unchanged; OWNER account never affected even if a role is mislabelled; snapshot refresh
picks up a flag change at the next refresh; every spoof signal listed above → still 403; observe mode writes an event and refuses nothing;
tenant and RLS isolation; concurrent role-flag change vs request; mutation sweep of the classification input and the snapshot field; Phase 3
frozen pins and the whole existing money suites unmodified.

## 6. Decisions needed from the owner

1. Choose **C** (recommended), A, B or D-only.
2. Approve **migration M55** (`role.deviceRequired`) and its S0 authorisation, or choose an option without a migration (D).
3. Approve the **additive snapshot member** (or place the flag in a separate server-side key, as B5.4 did for the binding).
4. Which system roles ship pre-flagged (recommendation: none — Owner decides per tenant), and the observe-mode period.
5. Confirm that the **POS PWA** release that presents `X-Device-Proof` (B5.9) must be in the field before any tenant is switched to enforce.
