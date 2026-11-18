# Independent security review handoff — `audit_log` immutability (AL1) and `security_event` isolation (SE1)

**Status: PREPARED FOR REVIEW — NOT APPROVED.** No reviewer, owner or accountant has signed anything; every box in this document is unticked and **independent review is not complete**. Nothing here is applied: no real migration, no permission change, no audit-action registration, no route, no commit. Both remediations are *drafts* with unapplied candidate migrations; the frozen schema, the live action registry and every frozen financial contract are unchanged.

## 0. Start here — the exact files a reviewer needs

| # | File | What it is |
|---|---|---|
| 1 | `docs/decisions/AL1-SE1-INDEPENDENT-REVIEW-HANDOFF.md` | this document: findings, blockers, activation order, checklist |
| 2 | `docs/decisions/proposed-migrations/DRAFT-AL1-audit-log-immutability.sql` | AL1 draft (source of truth) |
| 3 | `docs/decisions/proposed-migrations/DRAFT-SE1-security-event-isolation.sql` | SE1 draft (3 statements) |
| 4 | `docs/decisions/promotion-packages/phase-4-audit-log-immutability/` | AL1 package: candidate migration, `rollback.sql`, `pin-amendments.patch`, `compat.mjs`, `SECURITY-REVIEW-EVIDENCE.md`, `PACKAGE.json` |
| 5 | `docs/decisions/promotion-packages/phase-4-security-event-isolation/` | SE1 package: candidate migration, `rollback.sql`, `pin-amendments.patch`, `make-pin-amendments.mjs`, `README.md`, `PACKAGE.json` |
| 6 | `docs/decisions/promotion-packages/phase-4-security-preflight/` | **read-only catalog preflight** (`PREFLIGHT.sql`, `README.md`) for an authorized operator to run on staging / production |
| 7 | `docs/decisions/proposed-migrations/patches/T1-accounting-period-race-handler.patch` | T1: unapplied one-statement test-hygiene patch (§7) |
| 8 | `packages/db/test/phase4-audit-log-hardening.integration.test.ts` · `phase4-security-event-isolation.integration.test.ts` · `phase4-security-preflight.integration.test.ts` · `phase4-activation-order.integration.test.ts` | real-PostgreSQL proofs |
| 9 | `apps/api/src/verification/audit-log-hardening-package.structural.test.ts` · `security-event-isolation-package.structural.test.ts` · `security-preflight.structural.test.ts` | package pins |
| 10 | `docs/decisions/promotion-packages/phase-4-7-audit-registration/rehearse.mjs` | isolated-copy rehearsal of the whole stack (`registered+promoted+hardened+isolated`) |

## 1. Existing vulnerabilities and remediation

| # | Vulnerability (measured on disposable PostgreSQL 17) | Remediation |
|---|---|---|
| A1 | The application role could `UPDATE` and `DELETE` its own tenant's `audit_log` rows (Phase 1 default privileges grant S/I/U/D on every new table) | revoke, then grant exactly `SELECT, INSERT`; append-only row guard |
| A2 | The same through the partition `audit_log_default` (a partition is its own table with its own ACL) | revoke on parent **and** partition; guard cloned to every partition |
| A3 | `flower_platform` (BYPASSRLS) could rewrite or delete **any tenant's** audit rows | same privileges + guard (refused for every role) |
| A4 | `TRUNCATE` was possible and does not propagate to partitions | `TRUNCATE` guard on the parent and the partition |
| S1 | `flower_app` could read **every tenant's** `security_event` rows — and the tenant-less platform / pre-auth rows — when the view owner is a superuser (the test harness and `infra/staging/docker-compose.staging.yml`, which migrates as `postgres`): with its own tenant GUC (6 of 9 rows foreign), with **no GUC at all**, through the real `runScoped`; the tables stay isolated, the view is the only door; read-only | `security_invoker = true` + platform-only ACL (each layer alone closes it; owner-independent) |
| S2 | The Phase 1 default privileges also gave the application role `SELECT` on the view, contradicting the migration comment "the app role never does" | revoked by SE1 |

S1 is a **database-boundary gap, not a live application-level leak**: the only production reader of the view (`audit-read.repository.ts`) runs on the platform client (pinned by a source scan). With a non-superuser owner (`flower_migrate`, NOBYPASSRLS — the posture the migration comments describe) FORCE RLS binds the owner and the view is isolated (measured). **Whether production migrates as `flower_migrate` is not verified here** — that is exactly what the preflight (§6) is for.

### AL1 — privileges, safeguards, future partitions (summary; detail in the AL1 evidence file)

| Role | Before | After (parent **and** `audit_log_default`) |
|---|---|---|
| `flower_app` | S, I, U, D | **S, I** |
| `flower_platform` | S, I, U, D | **S, I** |
| `flower_migrate` (DDL) | ALL | no U / D / TRUNCATE |
| PUBLIC | none | none (explicitly revoked) |

- A `BEFORE UPDATE OR DELETE … FOR EACH ROW` append-only guard (cloned onto every partition) **refuses for every role including the owner and a superuser**; `TRUNCATE` guards on the parent and the partition; all four guards are **`ENABLE ALWAYS`** (they also fire under `session_replication_role = replica`). Proved on 11 UPDATE/DELETE statement shapes × application/platform roles, cross-tenant attempts are *permission denied* (never "0 rows"), `TRUNCATE` and `TRUNCATE CASCADE` refused.
- Self-check `fn_audit_log_protection_gaps()` reports any partition lacking a guard, with a disabled guard, or holding a privilege it must not.
- **Future partitions (measured):** a new partition inherits the cloned row guard **with `ENABLE ALWAYS`**, but is re-granted U/D by the default privileges and carries **no `TRUNCATE` guard**; the creating migration must revoke and add the guard, and the self-check (and preflight `P40`/`P41`) report exactly those gaps.

### RESIDUAL risks (not closed by AL1 / SE1 — the reviewer decides)

- **Owner / superuser DDL cannot be prevented by a trigger:** `ALTER TABLE … DISABLE TRIGGER`, dropping a guard, `DETACH`/`DROP` of a partition or the table. Measured: with the guard disabled the owner can `UPDATE`, and the self-check reports the disabled guard. Mitigation is a deployment-process control (who holds the owner role) plus running the self-check / preflight.
- **SE1 — view replacement:** `security_event` has been `CREATE OR REPLACE`d twice already (`20260906120000`, `20260906130000`). Measured (test R1h): a replacement **without** `WITH (security_invoker = true)` resets the option (the ACL survives). A standing structural pin requires any later replacing migration to restate it; the ACL layer is the backstop.
- **Staging is superuser-owned** (`migrate` connects as `postgres`): every object there is superuser-owned, so FORCE RLS does not bind the owner and `SECURITY DEFINER` functions run as a superuser. SE1 is owner-independent; changing staging's migration role is a **separate decision**. Reviewed and not an exposure: the only `SECURITY DEFINER` functions the application role can execute are two Phase 3b `RETURNS trigger` claim functions with a pinned `search_path` (pinned by a test, so a new one fails it).
- Not decided here: auditing of refused attempts (a refused self-approval writes no platform audit row — measured), a future hash chain (must be computed **at INSERT** because AL1 refuses later updates), retention / purge (none exists), the default privileges themselves.

## 2. RELEASE BLOCKERS vs OPTIONAL FUTURE HARDENING

### 2a. RELEASE BLOCKERS — each must be true, recorded, or explicitly decided before AL1 / SE1 are promoted

| ID | Blocker | State |
|---|---|---|
| **RB-1** | **Independent security review of AL1 and SE1** by a reviewer who did **not** write, direct or operate the implementation (not this AI-assisted implementation, not an agent or session started by it) | **OPEN** — not done; nothing here claims it |
| **RB-2** | **The preflight (§6) is run by an authorized operator on the real staging and production databases and the output reviewed** — in particular `P20` / `P21` (who owns the objects / runs migrations), `P30` / `P31` (the SE1 exposure), `P40` / `P41` (the AL1 gap). Production ownership is **unknown** to this work | **OPEN** — cannot be run from here (no access, no credentials requested) |
| **RB-3** | Owner / platform **approvals**: AL1-APPLY, AL1-RESIDUAL-RISKS, AL1-LEGACY-TEST-AMENDMENT, AL1-PARTITION-PROCEDURE, SE1-APPLY, SE1-FROZEN-VIEW (§9) | **OPEN** — all unticked |
| **RB-4** | **Frozen-pin amendments approved and applied in order** — `SE1-PIN-AMENDMENT` / AL1's equivalent (§4). Generated for both and proven in an isolated copy of the full stack; **not applied** | **OPEN** — generated, rehearsed, unapplied |
| **RB-5** | **D/Z1/E1 promotion is a prerequisite of the pin patches** (they are stacked after it). Promoting AL1 / SE1 *before* D/Z1/E1 would require regenerating both pin patches (the SQL itself is independent) | **OPEN** — D/Z1/E1 has its own owner / accountant / security approvals, outside this handoff |
| **RB-6** | **Migration-name conflict with the Inventory stack — owner decision D-ORDER** (§5; `SECURITY-OPERATOR-AND-REVIEWER-HANDOFF.md` §6). The **locked** Inventory checker reports `BEFORE_EXISTING_MIGRATIONS:H` the moment *any* Phase 4 migration is promoted under its current name, so the locked inventory order test fails the build **at Phase 4 promotion**, before Inventory is activated. *(An earlier version of this row said the inventory names should be re-chosen at activation; that is too late and would edit locked files — corrected.)* Proposed fix: re-stamp the five Phase 4 migrations into the gap before inventory step H; no locked file changes | **OPEN** — decision D-ORDER |

### 2b. RELEASE-PIPELINE items (not security blockers; decide before relying on a clean promotion run)

| ID | Item | State |
|---|---|---|
| **RP-1** | **T1** — an `unhandled` rejection from a latent race in `accounting-period.integration.test.ts` makes a run exit 1 (≈1 % per execution, with or without AL1); an unapplied one-statement patch removes it | decision open: apply `T1-accounting-period-race-handler.patch` or accept the flake |
| **RP-2** | **L2** — `order.controller.integration.test.ts` "L2" fails its "both outcomes occurred" coverage assertion under CPU load (reproduced **without** AL1); no integrity assertion ever failed | decision open: make the schedule deterministic or treat the coverage assertion as informational; re-run on the target pipeline |

### 2c. OPTIONAL FUTURE HARDENING (none is required for AL1 / SE1 to be correct)

1. Auditing of **refused** attempts (self-approval, missing permission, illegal transition).
2. A **hash chain** over `audit_log` — computed at INSERT (a BEFORE INSERT trigger or the application, under a per-tenant lock).
3. **Retention / purge** through its own approved, privileged procedure (AL1 authorises no bypass).
4. Migrating **staging as `flower_migrate`** instead of a superuser (SE1-STAGING-OWNERSHIP) and narrowing the **default privileges** (SE1-DEFAULT-PRIVILEGES).
5. Scheduling `fn_audit_log_protection_gaps()` / the preflight as a periodic monitor; an event-trigger or deployment control over the table-owner role (the residual DDL bypass).
6. Reviewing the tenant tables without FORCE RLS listed by preflight `P43`.

## 3. Exact migration order and rollback contract

**Activation order (lexical = intended; proved on real PostgreSQL by `phase4-activation-order.integration.test.ts`):**

| Step | Migration (candidate) | Package | Pin patch (stacked) |
|---|---|---|---|
| 0 | newest real migration `20261204120000_phase_4_device_permissions` | — | — |
| 1 | `20261205120000_phase_4_s5_register_session_count`, `…120100_phase_4_s5_z_report_storage`, `…120200_phase_4_7_expenses_and_other_income` | `phase-4-d-z1-e1` | `phase-4-d-z1-e1/pin-amendments.patch` |
| 2 | `20261205120300_phase_4_audit_log_immutability` | AL1 | `phase-4-audit-log-immutability/pin-amendments.patch` |
| 3 | `20261205120400_phase_4_security_event_isolation` | SE1 | `phase-4-security-event-isolation/pin-amendments.patch` |

Measured: the whole stack in **one** deploy, the **incremental** three-deploy production path, and **SE1-before-AL1** (the two are independent in SQL) all leave the *same* protection catalog; the audit_log is then append-only, the view `security_invoker` with a platform-only ACL, the self-check empty. The activation order is a **history / pin constraint, not a SQL one**.

**Rollback contract (each `rollback.sql` is manual SQL, never a Prisma history rewind):**

- **Reverse order:** SE1's `rollback.sql`, then AL1's. Measured: this restores the *exact* pre-stack catalog (view option, ACL privilege **sets**, triggers, functions). Each alone undoes only its own package (SE1 touches only the view; AL1 only `audit_log`).
- AL1's rollback applied twice **fails whole** and leaves the catalog untouched; SE1's is idempotent.
- **A rollback re-opens its vulnerability** (AL1: audit rows mutable again; SE1: the cross-tenant read where the owner bypasses RLS). Use it only to undo a faulty deployment.
- **Recovery is revert-forward (CLAUDE.md rule 37):** in production the rollback SQL is the body of a *new forward migration*; `_prisma_migrations` history is never edited. This operating procedure is **not exercised** here — only the SQL is.

## 4. Required frozen-pin amendments

| Patch | Files | What it does | Status |
|---|---|---|---|
| `phase-4-d-z1-e1/pin-amendments.patch` | 17 (structural pins, `frozen-baseline.ts`, schema-drift fixtures) | authorises D/Z1/E1 and moves the "newest migration" pins | generated, proven, **not applied** |
| `phase-4-audit-log-immutability/pin-amendments.patch` | 16 (pins, `frozen-baseline.ts`, `migration.test.ts`) | authorises AL1 (name + sha256, no model); moves the pins to AL1; amends one legacy assertion (a cross-tenant `DELETE` on `audit_log` is now *refused*, not "0 rows") | generated, proven, **not applied** |
| `phase-4-security-event-isolation/pin-amendments.patch` | 15 (13 "newest migration" pins, `frozen-baseline.ts`, and the two expected-migration lists — authorised list and cash-register — inside those files) | authorises SE1 (name + sha256, no model); moves the pins to SE1. The generator cross-checks that it moves **exactly** the files AL1's patch moved; the full-stack rehearsal caught a missed list entry in the first version | generated, proven, **not applied** |

The SE1 patch touches **only** `apps/api/src/verification/` (no schema, migration, source module, registry or fixture — pinned). It does **not** apply to the unpromoted tree (its pre-image holds the promoted and AL1 pins — pinned). The frozen view migration `20260904120000` is not edited. `migration.test.ts` needs no SE1 amendment: its `security_event` assertions test the view **definition**, which SE1 leaves unchanged.

## 5. Inventory S-1 review dependency

S-1 is the **separate** independent security review of the **inventory read-API activation pack** (`docs/mvp/INVENTORY-ACTIVATION-HANDOFF.md` §5–§6): 17 read routes, 34 files hashed in a manifest, **BLOCKED until a non-author reviewer is assigned**. AL1 / SE1 relate to it in three ways, none of which clears it:

1. **Manifest integrity (verified):** none of the 34 hashed files is touched by AL1 / SE1 work — the manifest still verifies 34/34. Any edit to them re-opens S-1.
2. **Review independence:** reviewing AL1 / SE1 does **not** satisfy S-1 and vice versa; the same independent reviewer may be asked for both, but each verdict is recorded separately.
3. **Migration naming (RB-6):** the inventory order manifest (`inventory-activation-manifest.json`) uses **placeholder** names — H = `20261205120000_inventory_company_costing_method` … S = `20261213…` — and states that real names "must sort after the newest existing migration". H's placeholder sorts **before** AL1 / SE1's candidates (and shares a timestamp prefix with the D step). **Correction:** the locked order test runs `checkManifest` against the *real* migrations folder, so it fails with `BEFORE_EXISTING_MIGRATIONS:H` as soon as any Phase 4 migration is promoted — before Inventory is activated — and re-choosing inventory names at activation would be too late and would edit locked files. The collision-free proposal (re-stamp the Phase 4 stack, leaving every locked file untouched) is pinned by `phase4-inventory-migration-ordering.structural.test.ts` and set out in `SECURITY-OPERATOR-AND-REVIEWER-HANDOFF.md` §6. The inventory permission migrations (Q / R) change no `audit_log` or `security_event` object.

## 6. Production / staging security preflight (RB-2)

`docs/decisions/promotion-packages/phase-4-security-preflight/PREFLIGHT.sql` is **one read-only `SELECT`** (`BEGIN READ ONLY … ROLLBACK`) over the PostgreSQL **catalogs only** — it never reads `audit_log`, `security_event` or any tenant row, needs no superuser, and is run **by an authorized operator with their own credentials**; this work never connects to either environment and never asked for credentials. It reports: the owner and BYPASSRLS / superuser status of the objects (`P20`–`P22`) and of the migration role (`P21`, run with the migration connection string), `SECURITY DEFINER` functions (`P23`), every view's exposure (`P30`, `P31`), `audit_log` parent **and partition** privileges and AL1 guards (`P40`, `P41`), RLS / FORCE RLS (`P42`, `P43`) and **default privileges for future objects** (`P50`). Proved on six postures (superuser-owned, `flower_migrate`-owned, AL1, SE1, both, both + owned) and as three non-superuser operators; verified not to change the catalog or read the audit tables. **Do not assume production matches the disposable test environments.**

| Preflight result | Meaning for release |
|---|---|
| `P30` **FAIL** or `P31` FAIL on `security_event` | the SE1 exposure is live in that environment → SE1 is required, not optional |
| `P40` / `P41` **FAIL** | the AL1 gap is live (audit rows mutable / a partition unguarded) → AL1 is required |
| `P20` / `P21` WARN | migrations run as a superuser / BYPASSRLS role → record the SE1-STAGING-OWNERSHIP decision (§2c) |
| `P50` WARN | future objects inherit `UPDATE` / `DELETE` for the app / platform roles (SE1-DEFAULT-PRIVILEGES, optional) |

## 7. Compatibility investigation — the two unexplained observations

Of three full runs of the 23 existing files on AL1-hardened databases, one exited 1 with an `ACCOUNTING_PERIOD_CLOSED` print (all 750 tests passed), one failed a single `order.controller` **L2** race test, one was clean. Both were investigated with logged, controlled reproductions (probe copies of the two tests; the originals are untouched). **Neither is caused by AL1; neither is "fixed".**

**`ACCOUNTING_PERIOD_CLOSED` — T1: mechanism established; a latent race in the test, independent of AL1.**
- *Source.* Vitest's "Unhandled Rejection" block; every test passes, the run exits 1. The only file in the set that can produce it is `accounting-period.integration.test.ts`, test "close acquires FOR UPDATE first" (lines 328–346): `postingAttempt` is created at line 328 but a rejection handler is attached only at line 346, after a 600 ms sleep and two awaited queries. The posting is released by the holder's `COMMIT` and rejects; if it rejects before line 346 runs, Node reports an **unhandled** rejection although the test then passes.
- *Deterministic proof.* Delaying only the handler attachment by 500 ms: **25/25** copies report the error, all pass, exit 1 — on an unhardened and on a hardened database alike.
- *Intervention.* With the same 500 ms delay and the handler attached at creation: **25/25 pass, 0 errors, exit 0** (`T1-accounting-period-race-handler.patch`, one statement, UNAPPLIED, verified with `git apply --check`).
- *Natural rate with the original statements* (100 copies per run, 3 runs per condition): plain config, no AL1 **3/300**; compat runner **without** AL1 **2/300**; compat runner **with** AL1 **2/300** (1 of 3 runs exits 1 in each) — **the error occurs on databases that have no AL1 at all**.
- *Discarded runs (stated, not hidden).* A first "delay 0" control still inserted a timer hop (5/25 errors) and was redone with nothing inserted; two CPU-stress runs timed out in the 120 s `beforeAll` hook and measured nothing.
- *Not directly observed.* The output of the original first-run event was not saved, so that specific event is attributed by identical signature, a single candidate test, and natural reproduction on unhardened databases — **highly probable, not observed**.

**L2 cancellation race — load-sensitive coverage assertion, reproduced without AL1; correctness assertions never failed.**
- All 9 failures seen under load are the same assertion — `cancellation-commits-first outcomes: expected 0 to be greater than 0` (the test requires at least one of 12 races to be won by the cancellation). No per-iteration integrity assertion (counts, ledgers, credit notes, audits) failed in any round.
- At idle: **0/16 rounds** had zero cancellation-first outcomes (plain 8, hardened 8; 1–3 of 12 per round). Under CPU stress (4 busy workers on 4 cores): **5/8 rounds (unhardened)** and **4/8 rounds (hardened)** had zero — the same failure, **on the unhardened database**.
- *Unexplained:* one hardened failure occurred earlier in an isolated loop on an otherwise idle machine; the machine load at that moment was not recorded, so it is consistent with load sensitivity but not demonstrated. No change is proposed to this frozen file.

## 8. Reviewer checklist (each item is for the reviewer to tick — all unticked)

- [ ] Recompute the sha256 recorded in `PACKAGE.json` for both packages and confirm each candidate migration is the draft behind a provenance banner, nothing more.
- [ ] Read both drafts: AL1 changes privileges + guards + one self-check and nothing else; SE1 is exactly three statements.
- [ ] Run `PREFLIGHT.sql` on **staging and production** with the migration connection string and an ordinary login; review `P20`–`P23`, `P30`/`P31`, `P40`/`P41`, `P50` (§6).
- [ ] Confirm who owns `security_event` and every table in production, and that `flower_app` is NOSUPERUSER NOBYPASSRLS and not a member of a bypass role (`P10`, `P11`).
- [ ] Run the four real-PostgreSQL suites and the three structural tests (§9) and inspect — not only read the result of — the tests that prove the findings (V0 control, E1b–E1d, R1e, R1h, O1–O4).
- [ ] Confirm no consumer outside this repository updates `audit_log` or reads `security_event` as `flower_app`.
- [ ] Confirm the deployment control over the table-owner role (the RESIDUAL owner / superuser DDL bypass) and the future-partition procedure.
- [ ] Review the three pin-amendment patches and the stacked order; confirm none edits a frozen production file, schema or financial contract.
- [ ] Decide T1 and L2 (§2b) and re-run L2 on the target pipeline.
- [ ] Record the verdict **separately** for AL1, for SE1, and (if the same reviewer) for Inventory S-1.

## 9. Approval register — NOT RECORDED (each is a human decision outside this repository's tooling)

| Approval | Owner | Accountant | Security reviewer |
|---|---|---|---|
| AL1-APPLY (privileges, guards, self-check) | - [ ] platform owner | - [ ] *acknowledgement only if the owner requests it* | - [ ] |
| AL1-RESIDUAL-RISKS (owner/superuser DDL, future partitions) | - [ ] | — | - [ ] |
| AL1-LEGACY-TEST-AMENDMENT (`migration.test.ts`: "refused", not "0 rows") | - [ ] | — | - [ ] |
| AL1-PARTITION-PROCEDURE (revoke + `TRUNCATE` guard for any new partition) | - [ ] | — | - [ ] |
| SE1-APPLY (`security_invoker` + platform-only ACL) | - [ ] platform owner | — | - [ ] |
| SE1-FROZEN-VIEW (amend the frozen `security_event` view's options / grants; definition unchanged) | - [ ] | — | - [ ] |
| Pin amendments applied in order D/Z1/E1 → AL1 → SE1 (AL1-PIN / SE1-PIN-AMENDMENT) | - [ ] | — | - [ ] |
| Independent security review complete — AL1 (AL1-REVIEW) | — | — | - [ ] |
| Independent security review complete — SE1 (SE1-REVIEW) | — | — | - [ ] |
| Staging migration ownership and default privileges (SE1-STAGING-OWNERSHIP, SE1-DEFAULT-PRIVILEGES) — optional hardening | - [ ] | — | - [ ] |

*Accountant:* no accountant approval is **required** by the frozen rules for AL1 / SE1 — neither touches a ledger, posting or financial contract. An acknowledgement is listed only because AL1 makes the financial audit rows tamper-resistant; the owner decides whether to ask for it.

## 10. Reproduce

```
cd packages/db
npx vitest run test/phase4-audit-log-hardening.integration.test.ts test/phase4-security-event-isolation.integration.test.ts test/phase4-security-preflight.integration.test.ts test/phase4-activation-order.integration.test.ts
# regenerate generated artefacts after a deliberate draft change: UPDATE_AUDIT_LOG_PACKAGE=1 / UPDATE_SE1_PACKAGE=1, then node docs/decisions/promotion-packages/phase-4-security-event-isolation/make-pin-amendments.mjs, then UPDATE_SE1_PACKAGE=1 again
node ../../docs/decisions/promotion-packages/phase-4-audit-log-immutability/compat.mjs            # existing tests on hardened databases (COMPAT_WITH_SE1=1 adds SE1)
node ../../docs/decisions/promotion-packages/phase-4-7-audit-registration/rehearse.mjs registered+promoted+hardened+isolated   # the whole stack in an isolated copy
psql "<connection>" -X -v ON_ERROR_STOP=1 -f ../../docs/decisions/promotion-packages/phase-4-security-preflight/PREFLIGHT.sql   # an authorized operator, read-only
```

## 11. What this document does NOT claim

Independent review is **not** complete. Production ownership, default privileges and the migration role are **unknown**. No approval is recorded. The revert-forward rollback *procedure* is untested (only its SQL is). T1 and L2 are **not** fixed. Inventory S-1 is **not** cleared.
