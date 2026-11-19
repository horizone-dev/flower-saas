# REGISTER PROVISIONING — readiness (components built, inert; route and permission blocked)

Status: **components built and tested; NOT reachable.** There is no route, no permission and no caller. Nothing here is approved.
Provisioning = creating the one `cash_register` row of a terminal and switching it active / inactive. It opens no session, writes no
movement, posts nothing to the general ledger, grants no permission and enrols no device.

## 1. What exists (all under `apps/api/src/modules/cash-register/`)

| File                                  | Role                                                                                                                                                                      |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `register-provisioning.ts`            | PURE decisions: `decideProvision`, `decideDeactivate`, `decideReactivate` (imports nothing, no I/O)                                                                       |
| `register-provisioning.repository.ts` | `RegisterProvisioningRepository` (`provision`, `deactivate`, `reactivate`); scoped repository; registered and exported by `CashRegisterModule`; used by **no** other code |
| `common/audit/actions.ts`             | 3 audit actions: `cash_register.register_provisioned` / `_deactivated` / `_reactivated` (configuration facts, `security:false`, bounded payload)                          |
| `cash-register.repository.ts`         | **fix found while building this**: `openSession` now re-reads the register AFTER its lock (see §3, finding 2)                                                             |

## 2. The requirements and where each is enforced

| Requirement                                | Application layer                                                                                                                                                                                                            | Database layer                                                                                 |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| **Terminal-to-register assignment**        | the terminal is read under RLS; the company / branch the caller asserts must equal the terminal's own (`TERMINAL_SCOPE_MISMATCH`); the row's company / branch are the TERMINAL's, never the caller's                         | composite FK proves terminal ∈ branch ∈ company ∈ tenant; identity columns immutable (trigger) |
| **Company / branch isolation**             | explicit `inScope` check of the caller's company and branch scope (single-branch, multi-branch and company-limited sessions), on top of RLS; an out-of-scope terminal or register is reported as _absent_, never _forbidden_ | RLS tenant + single-branch policy; other tenant's rows invisible                               |
| **Duplicate prevention**                   | per-terminal advisory lock, then an existence check: a second call is `ALREADY_PROVISIONED` (active or inactive); 8 concurrent provisions → one row, one audit row                                                           | `UNIQUE (tenantId, posTerminalId)`; a register is never deleted                                |
| **Device requirement** (_proposed policy_) | terminal ACTIVE and an ACTIVE enrolled device, to provision or reactivate (`requireActiveDevice`, default true; deactivation never needs a device, so a lost device cannot block switching a drawer off)                     | —                                                                                              |
| **Interlock with sessions**                | deactivation refused while any session is OPEN or COUNTING; an open and a deactivation serialise on the register's open lock                                                                                                 | partial unique indexes on unresolved sessions (existing)                                       |
| **Permission requirement**                 | **none can be enforced here**: no `cash_register:manage`-style key exists and none may be introduced without approval (P-2 / N6, a migration). The repository therefore has no caller; a future route carries the permission | S0b policy keeps all `cash_register:*` keys ungrantable                                        |
| **Audit**                                  | ONE audit row per change, written in the same transaction (a refused or rolled-back operation leaves none); actor and scope from the verified context                                                                        | —                                                                                              |
| **Lifecycle**                              | provision → deactivate → reactivate; each tested, including refusals and an open-vs-deactivate race                                                                                                                          | —                                                                                              |

## 3. Findings made while building (both fixed in the Phase 4 tree)

1. **Branch scope was not enforced by RLS for `pos_terminal`.** A branch-scoped (or multi-branch) session could _see_ a terminal of another
   branch; only `pos_device` was hidden, so the first test answered `NO_ACTIVE_DEVICE` instead of "not found". Fixed: the repository enforces
   the caller's company / branch scope explicitly and reports an out-of-scope row as absent. Tested for single-branch, multi-branch and
   company-limited sessions; two mutants (branch / company scope not enforced) are caught.
2. **Open-vs-deactivate race.** `openSession` read the register (`active`) _before_ taking its register lock, so an open that waited for a
   deactivation could then insert a session on a register that had just been switched off. Fixed: `openSession` re-reads the register after
   both locks and re-decides if `active` / the terminal status changed. Tested over 6 racing rounds (the invariant "never inactive with an
   unresolved session" holds) and pinned structurally (lock → lock → fresh read → session checks → insert).

## 4. Decisions needed before a route can exist (none taken)

| ID   | Decision                                                                                           | Recommendation (not approved)                                               | Migration?                                  |
| ---- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------- |
| PV-1 | Permission key(s) for provisioning (e.g. a `cash_register:manage` family) and which roles get them | Owner / Admin only, step-up required                                        | **Yes** (permission seed; part of P-2 / N6) |
| PV-2 | Is the device requirement part of policy?                                                          | Yes (default true)                                                          | No                                          |
| PV-3 | Deactivate while COUNTING                                                                          | Refused (as OPEN)                                                           | No                                          |
| PV-4 | Auto-provision when a terminal is created / enrolled, or explicit only                             | Explicit only (no side effects on terminal creation)                        | No                                          |
| PV-5 | Audit `security` flag for provisioning                                                             | `false` (configuration fact; a `security_event` view change is a migration) | No                                          |
| PV-6 | Route shape and refusal → HTTP mapping                                                             | see §5                                                                      | No                                          |

## 5. The smallest route, once PV-1 is approved (not built)

`POST /v1/companies/:companyId/branches/:branchId/pos-terminals/:terminalId/register` (provision) and `…/register/deactivate`,
`…/register/reactivate`, each `@RequirePermission(<PV-1 key>)`, `@ScopedParam({ company, branch })`, `@Idempotent`, step-up, mapping
`TERMINAL_NOT_FOUND`/`REGISTER_NOT_FOUND` → 404, `TERMINAL_SCOPE_MISMATCH`/`ALREADY_PROVISIONED`/`ALREADY_ACTIVE`/`ALREADY_INACTIVE`/
`UNRESOLVED_SESSION_EXISTS`/`TERMINAL_NOT_ACTIVE`/`NO_ACTIVE_DEVICE` → 409. It adds routes (the guard route-inventory and cross-tenant
probe pins must then be amended) — hence not built now.

## 6. Not done

Route, permission, Owner Web screen, any grant, any migration, any posting. Register provisioning is **not available to any user** today;
an unprovisioned terminal still answers `409 REGISTER_NOT_PROVISIONED`.

## 7. Verification (2026-11-14)

| Check                                                                                                                                                                                                                                                                                                                   | Result                                                                                                                                                                                                                                                 |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Unit (pure decisions)                                                                                                                                                                                                                                                                                                   | 11 / 11                                                                                                                                                                                                                                                |
| Integration on real PostgreSQL + Redis (assignment validation, isolation incl. single-branch / multi-branch / company-limited / cross-tenant, DB last-line constraints, duplicates incl. 8 concurrent, preconditions, audit, lifecycle, deterministic lock test, 6-round open-vs-deactivate race, whole-run invariants) | 15 / 15                                                                                                                                                                                                                                                |
| Structural pins (inert, writes, scope, lock order, audit registry, open-path re-read)                                                                                                                                                                                                                                   | 8 / 8                                                                                                                                                                                                                                                  |
| Mutation (6 pure + 9 repository + 1 open-path)                                                                                                                                                                                                                                                                          | **16 / 16 caught** — a first run left 2 survivors that were investigated: one was a broken-syntax mutant misclassified by the driver, the other (open lock removed) was a real gap in a probabilistic race test, closed by the deterministic lock test |
| `tsc`, build, ESLint, Prettier (changed files)                                                                                                                                                                                                                                                                          | clean                                                                                                                                                                                                                                                  |
| Full API regression of the patched tree that includes these components                                                                                                                                                                                                                                                  | 211 / 211 files; 5,236 passed, 0 failed, 2 skipped (first run: 1 failure — the `Number(` pin — fixed, then repeated)                                                                                                                                   |
| Real tree, targeted (cash-register module, device-session, cash-register / parity / provisioning / E-5 pins)                                                                                                                                                                                                            | 23 files, 522 / 522                                                                                                                                                                                                                                    |
| Migrations / permissions / frozen contracts                                                                                                                                                                                                                                                                             | none added or changed                                                                                                                                                                                                                                  |

## 8. Route wiring PREPARED in a disposable copy (2026-11-14) — not applied

Two patches in `docs/decisions/`: `PV-register-provisioning-routes.patch` (applies to the CURRENT tree) and
`PV-register-provisioning-routes.after-E5.patch` (applies on top of the two E-5 patches; the three overlap in `cash-register.module.ts` and the
module-directory pin, so they are NOT stackable in the plain form — apply either PV alone, or E-5 then the `after-E5` variant).
Both `git apply --check` clean; applied to pristine files they are byte-identical to the verified copies; the combined tree (E-5 + routes) typechecks and
passed all structural pins, the route-inventory and cross-tenant probe tests, the wired E-5 suite (16) and the route suite (7).

**Finding that changes PV-1:** provisioning is an Owner action from the web, so it must NOT use a `cash_register:*` key (the registered-device guard
demands a terminal device for that prefix). The patch reuses the EXISTING `devices:manage` key — already registered and granted to the Owner by
migration 52, step-up gated by code — plus the same Owner rule as device administration (`accountType = OWNER`, unrestricted scope). **No new
permission and no migration are needed for the routes.** Whether that is the right key is the owner's decision (PV-1 option A); option B is a dedicated
new key, which is a registry migration.

Routes (all `devices:manage`, `@ScopedParam(company, branch)`, `@Idempotent`, strict empty body, step-up, Owner-only):

| Route                                                         | Result                                                                                                                                                                                 |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /v1/companies/:c/branches/:b/pos-terminals/:t/register` | 201 `{ id, posTerminalId, companyId, branchId, active }`; 409 `ALREADY_PROVISIONED` / `TERMINAL_SCOPE_MISMATCH` / `TERMINAL_NOT_ACTIVE` / `NO_ACTIVE_DEVICE`; 404 `TERMINAL_NOT_FOUND` |
| `POST …/register/deactivate`                                  | 200; 409 `UNRESOLVED_SESSION_EXISTS` / `ALREADY_INACTIVE`; 404 `REGISTER_NOT_FOUND` (also for a path company / branch that is not the register's)                                      |
| `POST …/register/reactivate`                                  | 200; 409 `ALREADY_ACTIVE` / `TERMINAL_NOT_ACTIVE` / `NO_ACTIVE_DEVICE`; 404                                                                                                            |

Route tests (7, real HTTP + PostgreSQL + Redis): Owner web session provisions with one row and one audit row, idempotent replay, mandatory key; 6 concurrent
provisions give one 201 and five 409; no permission / no step-up / non-owner account with the key (OWNER_REQUIRED) all refused with nothing written;
cross-tenant Owner, wrong branch, wrong company refused; terminal with no device or a revoked device cannot be provisioned, a revoked device blocks
reactivation; full lifecycle with the open-session interlock; 4-round open-vs-deactivate race over HTTP. Route-layer mutation: 6 / 6 caught.

## 9. Final verification of the STANDALONE route patch (2026-11-14, fresh disposable copy = current tree + `PV-register-provisioning-routes.patch`)

`tsc` clean; **41 files, 1,348 tests passed** (3 opt-in load files skipped, 9 skipped tests): every structural pin, the registered-terminal-guard route inventory,
the cross-tenant probe, the 7 route tests, the 15 provisioning integration tests, the 11 provisioning unit tests. The copy was removed afterwards.

What the patch preserves (each with its evidence):

| Property                              | Evidence                                                                                                                                                            |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tenant / branch / company isolation   | route tests: other tenant's Owner, wrong branch, wrong company refused; repository `inScope` (single-, multi-branch, company-limited) tests; 2 scope mutants caught |
| Terminal-to-register verification     | company / branch asserted in the path must equal the terminal's own (409 `TERMINAL_SCOPE_MISMATCH`; 404 on toggle); DB composite FK is the last line                |
| Duplicate and concurrent provisioning | per-terminal advisory lock + `UNIQUE(tenantId, posTerminalId)`; 6 concurrent route calls → one 201, five 409                                                        |
| Open-vs-deactivate lock ordering      | the register's open lock is shared with `openSession`, which re-reads after its lock; deterministic lock test + 4-round HTTP race; lock-order pin                   |
| Audit integrity                       | one audit row per change in the same transaction, actor = the Owner; a refused operation leaves none                                                                |
| Owner-only                            | `devices:manage` + step-up + `accountType = OWNER` with unrestricted scope (service); a non-owner holding the key gets 403 `OWNER_REQUIRED`                         |

### Approved-change checklist (do NOT start before every box is signed; the patches now include a fail-closed feature gate (§10): applied, the routes still answer 404 until the deployment sets REGISTER_PROVISIONING_ENABLED=true)

| #   | Step                                                                                                                                                                                                                           | Owner   |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------- |
| 1   | Owner approves A-1 option A (`devices:manage`) — or chooses B (a new key: then a registry migration + the S0b authorisation first)                                                                                             | ☐       |
| 2   | Owner approves A-2, PV-2 (device requirement), PV-3, PV-4 (explicit only), PV-5                                                                                                                                                | ☐       |
| 3   | Independent security review of the 3 routes, the service and the repository (scope, Owner rule, locks, audit)                                                                                                                  | ☐       |
| 4   | Decide the application order with E-5: PV alone, or E-5 wiring → E-5 pins → `…after-E5.patch`                                                                                                                                  | ☐       |
| 5   | Apply the patch(es); no pin other than the two named in the patch changes                                                                                                                                                      | ☐       |
| 6   | tsc, ESLint, build, Prettier, DB / RLS tests, route + provisioning suites, full API regression                                                                                                                                 | ☐       |
| 7   | Verify CI on the final commit (a separate instruction is needed to commit)                                                                                                                                                     | ☐       |
| 8   | Staging: Owner provisions one terminal; check the audit row; a cashier opens a session; deactivate is refused while open                                                                                                       | ☐       |
| 9   | ~~Optional kill-switch~~ **built as a fail-closed FEATURE GATE and now part of both route patches** (§10): the routes stay `404 ROUTE_DISABLED` until the deployment sets `REGISTER_PROVISIONING_ENABLED=true` — step 10 below | ☑ built |
| 10  | After staging passes: the owner decides WHEN to set `REGISTER_PROVISIONING_ENABLED=true` in each environment (a deployment setting, not code)                                                                                  | ☐       |

## 10. FEATURE GATE (2026-11-14) — should the routes have an explicit flag? **Yes — built, fail-closed, in the patches, tested in disposable copies**

**Review answer.** The routes use `devices:manage`, which the Owner already holds, so without a gate they would be reachable by every Owner the moment
the patch is deployed — before staging, before the security review is complete, and with no way to withdraw them except a rollback. A gate makes
"deployed" and "enabled" two separate, reversible acts. It is a deployment setting, not a permission, so it needs no migration.

**Design (FAIL CLOSED).**

- The setting `REGISTER_PROVISIONING_ENABLED` is an optional string with **no default**. The ONLY value that opens the gate is the exact lower-case string
  `true`; unset, empty, `false`, `TRUE`, `1`, `yes`, ` true`, a typo, a non-string — all mean **disabled** (`parseProvisioningGate`, unit-tested on 18 inputs).
- Two independent layers: a controller guard answers **`404 ROUTE_DISABLED`** before the handler (the same answer for a real or an unknown terminal — no
  probing; an anonymous caller still gets 401), and the **service refuses every operation itself**, so a future second caller cannot bypass it.
- Nothing in the production source sets the flag (a structural pin scans every file); the real application is unchanged — the gate exists only inside the
  route patches.
- Opening the gate restores the normal behaviour exactly; closing it again stops all three routes at once and leaves registers as they were. An open gate
  weakens nothing else (Owner rule, step-up, scope, idempotency unchanged — tested).

**Evidence (disposable copies only).** Gate unit 2 / 2; route + gate integration 12 / 12 (7 route tests + 5 gate tests: closed → 404 for every route and
for an unknown terminal, nothing written, anonymous 401; the service refuses by itself; closed → open → closed; open gate keeps OWNER_REQUIRED /
STEP_UP_REQUIRED); gate mutants 8 / 8 caught (unset-means-enabled, case-insensitive, no-throw, guard removed, service ignores gate, default true, guard does
not assert, gate starts open). The two PV patches were regenerated WITH the gate; combined E-5 + gated routes: 43 files, 1,371 tests passed; standalone
gated routes: 43 files, 1,362 tests passed.

**Operating it (once approved).** Apply the patch → deploy with the flag unset (routes 404) → staging: set `REGISTER_PROVISIONING_ENABLED=true` → verify →
production decision by the owner. Rollback = unset the flag (instant, no data change).
