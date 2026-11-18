# F-7 staff onboarding — independent security review pack

Date 2026-11-14 · status: **READY FOR REVIEW, route NOT enabled, nothing approved.**

## Scope under review

`apps/api/src/modules/access/staff-onboarding.service.ts` and `.repository.ts` (inert: imported by nothing), the draft route `docs/decisions/proposed-migrations/DRAFT-F7-staff-invite.controller.ts.txt` (`POST /v1/platform/tenants/:tenantId/staff-invites`, platform realm), tests `staff-onboarding.integration.test.ts`. No migration, no new permission.

## Trust boundaries and controls

| Threat                                    | Control (code)                                                                                                                | Test                                                                 |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Unauthorised caller creates accounts      | route: `@PlatformRealm()` + existing `platform:tenant_users:manage` (step-up MFA); service refuses a missing actor            | route-level tests belong to enablement (see checklist)               |
| Privilege escalation via role             | allow-list `cashier` / `sales` only; owner, admin, manager, accountant, unknown → `ROLE_NOT_ONBOARDABLE`                      | ✔                                                                    |
| All-access account                        | scope must list ≥ 1 company and ≥ 1 branch; `*ScopeAll` always false                                                          | ✔                                                                    |
| Cross-tenant / cross-company scope        | every company and branch re-read inside the platform transaction with `tenantId`; each branch must belong to a listed company | ✔ (3 shapes) + mutant (check removed → caught)                       |
| Cross-tenant role                         | role looked up by `(tenantId, key)`                                                                                           | ✔                                                                    |
| Duplicate / account takeover by re-invite | email unique per tenant (409), no second token, raw token never re-revealed or cached                                         | ✔                                                                    |
| Token theft at rest                       | 256-bit random, only SHA-256 stored, 24 h TTL, single use (existing consumer)                                                 | ✔ (hash only, not raw; expired refused; reuse refused)               |
| Token leakage via audit/logs              | audit rows carry role/scope ids only; response is `no-store` (draft route); test asserts the token is absent from audit       | ✔                                                                    |
| Mass creation / abuse                     | per-actor 20/h and per-workspace 50/day Redis budgets, spent before any work, **fail-closed** without Redis                   | ✔ (429; Redis-down refusal)                                          |
| Plan-limit bypass by races                | tenant row lock + `max_users` re-count in the transaction                                                                     | ✔ 12 concurrent vs 3 slots → exactly 3; mutant (lock removed) caught |
| Half-created account                      | single platform transaction, audit inside it                                                                                  | ✔ (every refusal leaves nothing)                                     |
| Login before invite use                   | no credential row exists                                                                                                      | ✔                                                                    |
| Inactive workspace                        | `TENANT_NOT_ACTIVE`                                                                                                           | ✔                                                                    |
| Audit                                     | `user.created`, `user.roles_changed`, `user.scope_changed` by the platform actor, same transaction                            | ✔                                                                    |

## Known gaps / questions for the reviewer

1. **Delivery of the raw token**: returned once in the response body to the operator (draft). Alternative: outbox email. Either needs a decision; the token must never be logged by a proxy (draft sets `Cache-Control: no-store`).
2. The per-actor budget key uses the platform user id; consider an additional per-IP budget at the edge.
3. The 24 h TTL and the 50/day workspace budget are proposals.
4. No "revoke an unused invite" or "re-issue" operation exists yet (needed for operations; a disabled user can be handled through the existing disable path).
5. Owner Web cannot use this (platform realm). A tenant-realm "invite my staff" route for owners is a **separate** design with its own review (new permission → S0b).
6. Timing/enumeration: duplicate email returns 409 to a platform operator (acceptable for the realm); it must not be exposed to a tenant-realm caller.

## Enablement checklist (after approval)

Copy the draft controller into `src` · register controller + `StaffOnboardingService`/`Repository` in `AccessModule` · add route tests: 401 without a platform token, 403 for a tenant-realm token and for a platform user without `platform:tenant_users:manage`, 403 without step-up, body validation (`.strict()`), response headers · add the cross-tenant probe entry and the route-inventory pin · rerun structural pins and the probe suite · record the decision in DECISION-LOG.
