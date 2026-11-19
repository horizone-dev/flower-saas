# Security-review evidence — `audit_log` immutability hardening (AL1)

**Status: PREPARED, NOT APPROVED.** Evidence for a reviewer; no sign-off is recorded or implied (§9 is unticked). Nothing is applied: the draft is `docs/decisions/proposed-migrations/DRAFT-AL1-audit-log-immutability.sql`, the candidate
migration lives only in this package, the real migrations / schema / registry are unchanged. All facts below were measured on disposable PostgreSQL 17 databases built by the real migrations.

## 1. The vulnerability (measured, control test `V0`)

| # | Finding | Measured |
|---|---|---|
| 1 | The application role can rewrite or delete its own tenant's audit rows | `UPDATE` and `DELETE` on `audit_log` each affected 1 row inside a `flower_app` transaction |
| 2 | …through the partition too | `UPDATE audit_log_default …` affected 1 row (a partition is its own table with its own ACL: a parent-only REVOKE would leave it open) |
| 3 | The platform role reaches every tenant | `flower_platform` (BYPASSRLS, no tenant GUC) deleted another tenant's row |
| 4 | No protection existed beyond RLS | no trigger on `audit_log`; RLS only hid other tenants from the application role |
Root cause: the Phase 1 `ALTER DEFAULT PRIVILEGES … GRANT SELECT, INSERT, UPDATE, DELETE` covers every new table, `audit_log` included; the table was never revoked or guarded.

## 2. Impact assessment — does anything legitimate need UPDATE, DELETE or TRUNCATE? No.

| Area | Finding |
|---|---|
| Writers | `AuditWriter.record` / `emit` (`tx.auditLog.create`), `provisioning.repository` (`createMany`), the platform-operator bootstrap (`create`) — **INSERT only** (pinned by `audit-log-hardening-package.structural.test.ts`: a scan of every production source for any update / delete / upsert / TRUNCATE of `audit_log` finds none, and the writer set is exactly those three) |
| Readers | platform audit-read (platform path), one raw SELECT in the Z sales-facts read, the `security_event` view (reads as its owner) — all keep SELECT |
| Dependencies | no FK to or from `audit_log`; nothing cascades into it; no retention / purge job exists; `prevHash` / `entryHash` are unwritten (OD-P2-1) |
| Partitions | exactly one: `audit_log_default`; no partition-management code exists |
| Roles | `flower_app` (NOBYPASSRLS), `flower_platform` (BYPASSRLS), `flower_migrate` (DDL, NOLOGIN), `flower_dispatcher` (no access since Phase 2); the table owner is the migration role |
| Existing tests | one asserts a cross-tenant `DELETE FROM audit_log` returns zero rows (`packages/db/test/migration.test.ts`, "tenant B cannot read, update or delete tenant A rows"): after AL1 the statement is **refused** — a stronger result; the amendment is in `pin-amendments.patch`; one test creates its own `BEFORE INSERT` trigger on `audit_log` (coexists, proved in the compatibility run) |
Bypass paths found and addressed or recorded: partition ACL (revoked), TRUNCATE not propagating to partitions (guard on each), `session_replication_role = replica` (guards are `ENABLE ALWAYS`), over-granted future partitions (cloned row guard + self-check), owner DDL (RESIDUAL §6).

## 3. The safeguards (DRAFT AL1) — each proved separately

The table becomes append-only: rows can be inserted and read, never rewritten, deleted or truncated.
1. **Privileges**: `REVOKE ALL` from PUBLIC / `flower_app` / `flower_platform` on the parent **and** the partition, then exactly `SELECT, INSERT`; `UPDATE, DELETE, TRUNCATE` also revoked from the DDL role.
2. **Append-only row guard** (`BEFORE UPDATE OR DELETE … FOR EACH ROW`, cloned onto every partition): refused for every role including the owner and a superuser.
3. **TRUNCATE guard** on the parent and on `audit_log_default` (a statement trigger does not propagate to partitions).
4. **`ENABLE ALWAYS`** on all guards: they also fire under `session_replication_role = replica`.
5. **Self-check** `fn_audit_log_protection_gaps()`: lists every partition lacking a guard, with a disabled guard, or holding a privilege it must not (callable by the platform and DDL roles only).
Unchanged (pinned): the RLS policy, `FORCE ROW LEVEL SECURITY`, the `security_event` view definition and ACL, the Prisma schema and its drift baseline, and every INSERT path.

## 4. Real PostgreSQL results (`phase4-audit-log-hardening.integration.test.ts`, 15 tests)

- **Deploy over existing data** by the real `prisma migrate deploy`: 12 pre-existing rows of every kind (authentication, RBAC, accounting, financial, device, impersonation, platform) are byte-identical afterwards (row hash equal), partitions readable, view / policy / schema-drift unchanged.
- **UPDATE / DELETE refused** on 11 statement shapes × application / platform roles (parent, partition, hash columns, upsert, MERGE UPDATE and DELETE, row locks) — *permission denied*; the superuser is stopped by the guard; replica mode is stopped too. **Cross-tenant** UPDATE / DELETE is permission-denied (never "0 rows"); a foreign-tenant INSERT is an RLS violation.
- **TRUNCATE and TRUNCATE CASCADE** refused on the parent and the partition, 6 statement shapes × 3 role classes; counts unchanged.
- **Exact privileges** on the parent and the partition; PUBLIC none; no UPDATE / DELETE / TRUNCATE for the DDL role; self-check empty; self-check not callable by the application role.
- **Valid INSERTs keep working** through the **real Prisma client** (`create`, `createMany`, application and platform paths) for every event kind; UPDATE / DELETE through the same client are refused and the row is unchanged; the `security_event` view still reports exactly the security actions.
- **Transaction rollback on audit failure** (CHECK violation): the business row is gone; **40 concurrent inserts** across two tenants and the platform lose nothing while 20 concurrent tampering attempts are all refused.
- **Rollback and repeatability**: `rollback.sql` restores the previous catalog exactly (the vulnerable state, by design); re-applying gives the identical hardened catalog; a second apply fails whole; a deliberately broken deployment leaves nothing behind. No audit row is lost or altered at any step.
- **Mutations**: 13/13 mutants of the draft caught **behaviourally** (e.g. a missing REVOKE, partition not revoked, DELETE not guarded, a guard that does not refuse, a missing TRUNCATE guard on parent or partition, a guard not `ENABLE ALWAYS`, a blind self-check).
- **Compatibility of existing platform tests** (unchanged files, hardened databases): 23 files / 750 tests, one hardened database per file (23 for 23, so none bypassed the shim). **Three full runs, reported as observed, not only the clean one**: run 1 — 750/750 passed but the process exited 1 because vitest printed `DomainError … ACCOUNTING_PERIOD_CLOSED` (the output was not saved, so this error is **UNATTRIBUTED**; it did not recur and the two accounting files passed 7/7, 17/17 and 21/21 alone); run 2 — 749/750, one failure in `order.controller.integration.test.ts` L2 ("12 async-reservation-vs-cancellation races": it needs at least one cancellation-first outcome, `expected 0 to be greater than 0`); run 3 — 750/750, exit 0. L2 is a timing race with a thin margin: in 24 controlled runs (16 filtered + 8 full-file, alternating unhardened / hardened) it never failed and the outcome distribution was the same under both (cancellation-first 1–2 of 12). AL1 adds no trigger or privilege to the INSERT path, so no mechanism links it to L2, but a causal link is **not excluded by a failing reproduction — it is neither proven nor disproven**; the reviewer should treat L2 as load-sensitive and re-run it on the target pipeline. **UPDATE 2026-11-17 — both were then investigated with logged, controlled reproductions** (`docs/decisions/AL1-SE1-INDEPENDENT-REVIEW-HANDOFF.md` §7): the unattributed `ACCOUNTING_PERIOD_CLOSED` print is an unhandled rejection from a latent race in the test (handler attached late), reproduced deterministically and **also on databases without AL1** (natural rate ≈1% per execution in all three conditions; a one-statement unapplied patch `T1-accounting-period-race-handler.patch` removes it); L2 failed only its "both outcomes occurred" coverage assertion, in 0/16 idle rounds and in 5/8 (unhardened) and 4/8 (hardened) rounds under CPU stress — **load-sensitive and independent of AL1; neither is fixed**
- **Registered-state expense rehearsal on the hardened table**: all eight expense audit actions, REQUIRED policy, same-transaction `xmin`, a real `audit_log` failure rolling everything back, concurrency, replay, scope — the rehearsal runs against the hardened table (`registered+hardened`: the former "tamper = GAP" evidence becomes "tamper refused"), and the full stack (`registered+promoted+hardened`: D / Z1 / E1 promotion + AL1 candidate + all stacked pin amendments, 42 files / 1441 tests) is green

## 5. Interaction with the expense audit work

`expense_event` remains the expense's own immutable history and is **not** the platform audit trail; the eight proposed `expense_record.*` / `expense_category.*` / `other_income.*` actions are still unregistered. With AL1 their rows become tamper-resistant (the rehearsal's former "GAP" evidence flips to "refused"). AL1 does not decide the action names, the payload allow-list or the REQUIRED policy.

## 6. RESIDUAL RISKS (not closed — the reviewer decides)

- **Owner / superuser DDL**: `ALTER TABLE … DISABLE TRIGGER`, dropping a guard, `DETACH` / `DROP` of a partition or the table. A trigger cannot stop DDL. Measured: with the guard disabled the owner can `UPDATE`, and the self-check reports the disabled guard. Mitigation is a deployment-process control (who holds the owner role) and running the self-check; an event trigger would need a superuser.
- **A new partition** is a new table: the default privileges re-grant it UPDATE / DELETE and it carries no TRUNCATE guard. Measured: the cloned row guard **does** protect it (and inherits `ENABLE ALWAYS`), but the revoke and the TRUNCATE guard must be added by the creating migration; the self-check reports exactly those gaps and the procedure that closes them is exercised in the test.
- **Pre-existing, independent of AL1 (observation)**: the Phase 1 default privileges also give `flower_app` SELECT on the `security_event` view, contradicting the comment that "the app role never does". In the test environment the view owner is a superuser (bypasses RLS), so tenant A's transaction saw 14 rows of which 6 belonged to other tenants / the platform. In production the owner is not a superuser, so RLS would apply — **unverified here**. Not changed by AL1; needs a separate decision.

## 7. Separate review decisions (NOT decided here)

- **Auditing of refused attempts (refused-attempt auditing)**: a refused self-approval, missing permission or illegal transition writes no platform audit row (measured). Whether and where to record them is a separate decision.
- **A future hash chain** (OD-P2-1, `prevHash` / `entryHash`): AL1 refuses any later UPDATE, so a chain writer must compute the hash **at INSERT** (a BEFORE INSERT trigger or the application, under a per-tenant lock).
- **Retention / purge**: none exists; any future purge would need its own approved, privileged procedure — AL1 authorises no bypass.

## 8. Reproduce

`cd packages/db && npx vitest run test/phase4-audit-log-hardening.integration.test.ts` (set `UPDATE_AUDIT_LOG_PACKAGE=1` to regenerate the candidate, rollback and manifest); `node docs/decisions/promotion-packages/phase-4-audit-log-immutability/compat.mjs` (existing tests on hardened databases); `node docs/decisions/promotion-packages/phase-4-7-audit-registration/rehearse.mjs registered+hardened` and `registered+promoted+hardened`.

## 9. Sign-off (NOT RECORDED — each is a human, outside this repository's tooling)

- [ ] Apply the hardening (AL1-APPLY)   - [ ] Accept the residual risks (AL1-RESIDUAL-RISKS)
- [ ] Amend the legacy isolation test (AL1-LEGACY-TEST-AMENDMENT)   - [ ] Adopt the future-partition procedure (AL1-PARTITION-PROCEDURE)
