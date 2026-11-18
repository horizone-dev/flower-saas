# Security review & staging preflight — operator and reviewer handoff (AL1 + SE1)

**Status: PREPARED — NOT APPROVED.** Nothing here connects to staging or production, requests a credential, applies a migration or role change, approves a finding, or records an approval. Independent review is **not** complete. The full findings and proofs are in `docs/decisions/AL1-SE1-INDEPENDENT-REVIEW-HANDOFF.md` (the "main handoff"); this page is the operational layer on top of it.

## 1. The preflight file

| | |
|---|---|
| **Location** (repo-relative) | `docs/decisions/promotion-packages/phase-4-security-preflight/PREFLIGHT.sql` |
| **Location** (local worktree) | `C:\Users\EXPERT\fwt\p4\docs\decisions\promotion-packages\phase-4-security-preflight\PREFLIGHT.sql` |
| Companions (same folder) | `preflight-report.mjs` (offline redact / classify tool) · `README.md` (the checks P01–P50, minimum access, classification) |
| sha256 of `PREFLIGHT.sql` (LF-normalised) | `a6c0fc0fd35b37dd6c17324a9ed8fa65cd5863def29453d7b8c98d0892015060` |
| sha256 of `preflight-report.mjs` | `fa9df4c406d6659c1cba488007b3c8d9e3c2962814ed97257ccfcc2495e104ac` |

Recompute on the copy you hold — `tr -d '\r' < PREFLIGHT.sql | sha256sum` — and stop if it differs (a test fails if these two values go stale). **Delivery:** the package is **uncommitted** in the local worktree; Claude does not commit, push or share it. The owner decides how it reaches the operator and the reviewer (a reviewed commit / PR, or a copy of the files) and both check the hashes. **The exact files, with a sha256 each, are listed in `docs/decisions/security-review-share/SHARE-MANIFEST.json`** (an *operator* pack and a *reviewer* pack); a recipient verifies them with `node share-pack.mjs verify <folder> operator|reviewer`, and the owner sends the hashes of `share-pack.mjs` and `SHARE-MANIFEST.json` (`node share-pack.mjs hashes`) through a **separate channel**. The operator's step-by-step is `docs/decisions/STAGING-PREFLIGHT-RUNBOOK.md` (staging only); the owner's sheet for decision D-ORDER is `docs/decisions/D-ORDER-OWNER-DECISION.md`.

## 2. Safe, read-only execution — staging first, then production

1. **Staging first.** Run, review and have the report reviewed **before** touching production.
2. Use the operator's **own** credentials through the normal secret mechanism (`PGPASSFILE`, `PGSERVICE`, an environment variable set outside the command) — never type a password into the command, never share one with the reviewer or with Claude.
3. Capture (one command; it is the exact command proved with real `psql` in `phase4-security-preflight-operator.integration.test.ts`):
   `PGOPTIONS='-c default_transaction_read_only=on' psql "<connection>" -X -q -v ON_ERROR_STOP=1 -A -F "$(printf '\t')" --pset footer=off -f PREFLIGHT.sql > captured.tsv`
4. Run it **twice** per environment: once with the **migration** connection string (so `P21` shows the migration role's superuser / BYPASSRLS status), once with an ordinary login.
5. Produce the report: `node preflight-report.mjs captured.tsv --env staging --script PREFLIGHT.sql --out preflight-staging.md` (use `--env production` for production).
6. Send **only the report** to the reviewer. Keep `captured.tsv` inside the environment.
7. Production only after the staging report is reviewed. If a read replica exists it may be used instead of the primary (the catalog is identical; optional, not tested here).

The script is **one `SELECT` inside `BEGIN READ ONLY … ROLLBACK`** over the PostgreSQL catalogs: it never reads `audit_log`, `security_event` or any tenant row (a table scan would show in the tables' read counters, which stayed unchanged — measured), and it changes nothing (the catalog fingerprint is identical before and after — measured). It only looks up catalog metadata, so no change window is expected; the operator's own change-control policy decides.

## 3. Minimum database access (measured with real `psql`)

`CONNECT` on the database and `USAGE` on schema `public` — both are the defaults every role has — and **nothing else**: no superuser, no table privilege (the login cannot even `SELECT` from `audit_log`), no role membership. Without `USAGE` on `public` the script fails (`permission denied for schema public`); without `CONNECT` it fails (`permission denied for database`); both give an empty capture that the report tool classifies as **UNPARSEABLE**, never as a pass. **Do not borrow the application's (`flower_app` / `flower_platform`) credentials** — a dedicated read-only login or your own admin login is enough.

## 4. Capturing and redacting without exposing credentials or tenant data

- **What the capture contains:** server version, role / object / ACL names, owners, booleans, guard states. **No** credential, connection string, host, row, tenant identifier. The only personal item is the operator's own login name (rows `P02`, `P21`).
- **The tool** (`preflight-report.mjs`, offline: no network, no process, no environment read; writes only `--out`) **redacts** the operator's login (replaced by `<ROLE_n>`; the superuser / BYPASSRLS attributes are kept) and **refuses** (exit 3, naming the *reason*, never the matched text, writing nothing) a capture containing a connection string, password / secret / token assignment, private-key block, IPv4 address, UUID (tenant or row id), JWT-like token, a 64+ character opaque string, or a domain host name.
- **Never** hand-edit a capture or report and forward it; if the tool refuses, fix it at the source and re-run. **Never** paste the `psql` command with a connection string into a ticket or chat.
- 12 / 12 mutants of the tool's rules are caught by its tests; its behaviour on real `psql` output, with a personal-looking login, is proved end to end.

## 5. Expected findings and how to classify PASS / FAIL / UNKNOWN

**Classes.** PASS / FAIL / WARN / INFO are the script's own verdicts, taken verbatim. **UNKNOWN** = a check the reviewer needs produced **no row** (the object may not exist in that environment, or the check could not run); **UNKNOWN is never PASS**. UNPARSEABLE / REFUSED = no report. The tool approves nothing; the reviewer classifies the *meaning*:

| Result | What it means for release |
|---|---|
| `P30` / `P31` **FAIL** on `security_event` | the SE1 exposure is live in that environment → SE1 required |
| `P40` / `P41` **FAIL** | the AL1 gap is live (audit rows mutable / a partition unguarded) → AL1 required |
| `P10` / `P11` / `P42` **FAIL** | a design invariant is broken (a role attribute, an RLS boundary) → **stop and escalate**; AL1 / SE1 do not fix it |
| `P20` / `P21` / `P22` / `P23` WARN | migrations run as, or objects are owned by, a superuser / BYPASSRLS role → record decision `SE1-STAGING-OWNERSHIP` (optional hardening) |
| `P50` WARN | future objects inherit `UPDATE` / `DELETE` for the app / platform roles → `SE1-DEFAULT-PRIVILEGES` (optional) |
| any **UNKNOWN** | the reviewer obtains the missing fact (re-run, ask the operator). An UNKNOWN on `P30`, `P40`, `P41` or `P42` **blocks sign-off** |

**Expected on STAGING** (an inference from `infra/staging/docker-compose.staging.yml`, whose `migrate` service connects as `postgres` — **not an observation**): `P20` WARN ×4, `P21` WARN (migration string), `P22` WARN, `P23` WARN ×2, **`P30` FAIL**, **`P31` FAIL** (`flower_app`) / WARN (`flower_platform`), **`P40` FAIL** (app and platform roles, parent and partition), **`P41` FAIL**, `P42` PASS ×2, `P50` WARN. **Production is unknown**: if it migrates as `flower_migrate`, expect `P20` PASS, `P30` WARN, `P40` / `P41` FAIL; if as a superuser, the same as staging. Any difference from these expectations is itself a finding for the reviewer.

## 6. Migration timestamp conflict with the Inventory stack — and a collision-free ordering

**The conflict (proved by the locked checker's own verdict, `phase4-inventory-migration-ordering.structural.test.ts`).** Inventory step H is stamped `20261205120000` (`…_inventory_company_costing_method`); the Phase 4 stack is `20261205120000`, `…120100`, `…120200`, `…120300`, `…120400`. The locked order test runs `checkManifest(manifest, <real migrations folder>, …)`. After **every** prefix of the stack is promoted it returns exactly one violation, **`BEFORE_EXISTING_MIGRATIONS:H`** (H ties with the D step and sorts before it, `i` < `p`; steps I…S are stamped later and are unaffected) — so the locked inventory test fails the build **at Phase 4 promotion**, before Inventory is activated. Re-choosing inventory names at activation is therefore too late and would edit locked files. The two stacks have **no SQL dependency in either direction** (no inventory draft names a Phase 4 object and vice versa).

**The Inventory S-1 files are locked**: the order manifest `inventory-activation-manifest.json`, its checker `inventory-migration-manifest.ts` and the drafts are among the 34 hashed S-1 files. Nothing below edits one.

**Proposal D-ORDER (Option A, recommended) — re-stamp the five Phase 4 migrations into the 24-hour gap between the newest real migration (`20261204120000`) and inventory step H (`20261205120000`)**, same slugs, same relative order:

| Step | Current name | Proposed name |
|---|---|---|
| D | `20261205120000_phase_4_s5_register_session_count` | `20261204130000_phase_4_s5_register_session_count` |
| Z1 | `20261205120100_phase_4_s5_z_report_storage` | `20261204130100_phase_4_s5_z_report_storage` |
| E1 | `20261205120200_phase_4_7_expenses_and_other_income` | `20261204130200_phase_4_7_expenses_and_other_income` |
| AL1 | `20261205120300_phase_4_audit_log_immutability` | `20261204130300_phase_4_audit_log_immutability` |
| SE1 | `20261205120400_phase_4_security_event_isolation` | `20261204130400_phase_4_security_event_isolation` |

Proved with the locked checker: silent after every promotion prefix, silent for the final folder (real + Phase 4 + all nine inventory steps), and one consistent lexical = temporal order **real → Phase 4 → Inventory**. Cost: a mechanical rename of 5 package directories and the names in 14 files (the three package manifests and READMEs, the three pin patches, the two DB-test constants, `rehearse.mjs`, `promotion-package.structural.test.ts`, `helpers/promotion-package.ts`, the main handoff) followed by regenerating the patch hashes and re-running the stack rehearsal. **No `migration.sql` content or hash changes; no S-1 file changes; all 21 approvals in the three package manifests are unrecorded, so none is invalidated.** *Not done — it needs the owner's decision first.*

**Rejected alternatives.** *B — activate Inventory first:* measured on real PostgreSQL, `prisma migrate deploy` applies an earlier-sorting migration **after** a later one **without error**, so it works — but the migration history would be out of order (an existing environment: H, I … S then the Phase 4 stack; a fresh database: H, D, Z1, E1, AL1, SE1, I … S), and the pins that name the "newest migration" would disagree with the history. *C — edit the inventory manifest's stamps:* edits a locked S-1 file and reopens S-1. In every environment the activation order must equal the lexical order.

## 7. Release blockers and the 29 unticked boxes

The **29 unticked boxes** are **10 reviewer-checklist items (C1–C10) + 19 approval boxes (A1–A19)**, all in the main handoff (§8, §9) — the only place they are ticked. One decision is **new and not among the 29**: **D-ORDER** (§6).

| Blocker | What clears it | Boxes |
|---|---|---|
| **RB-1** independent review of AL1 and SE1 by a non-author | the reviewer's verdicts | C1–C10, A16, A17 |
| **RB-2** preflight run by an authorized operator on the real staging and production databases, output reviewed | §2–§5 above | C3, C4 |
| **RB-3** owner / security approvals to apply AL1, SE1 and amend the frozen view | apply, residual risks, legacy-test amendment, partition procedure, frozen view | A1–A13 (A2 = accountant acknowledgement, only if the owner requests it) |
| **RB-4** frozen-pin amendments applied in order D/Z1/E1 → AL1 → SE1 | owner + security approval | A14, A15 (and C8) |
| **RB-5** D/Z1/E1 promoted first | its own package approvals (13, unrecorded — **outside the 29**) | — |
| **RB-6** migration-name conflict with the Inventory stack | owner decision **D-ORDER** | D-ORDER |

Optional hardening (not blockers): A18 / A19 (staging migration role, default privileges), refused-attempt auditing, a hash chain, retention. Pipeline items (not security blockers): T1 `unhandled` rejection patch and the L2 race test — decisions inside C9.

| ID | Approval box (main handoff §9) | ID | Approval box |
|---|---|---|---|
| A1 | AL1-APPLY — owner | A11 | SE1-APPLY — security |
| A2 | AL1-APPLY — accountant acknowledgement (if requested) | A12 | SE1-FROZEN-VIEW — owner |
| A3 | AL1-APPLY — security | A13 | SE1-FROZEN-VIEW — security |
| A4 | AL1-RESIDUAL-RISKS — owner | A14 | pin amendments in order — owner |
| A5 | AL1-RESIDUAL-RISKS — security | A15 | pin amendments in order — security |
| A6 | AL1-LEGACY-TEST-AMENDMENT — owner | A16 | independent review complete, AL1 — security |
| A7 | AL1-LEGACY-TEST-AMENDMENT — security | A17 | independent review complete, SE1 — security |
| A8 | AL1-PARTITION-PROCEDURE — owner | A18 | staging ownership / default privileges — owner |
| A9 | AL1-PARTITION-PROCEDURE — security | A19 | staging ownership / default privileges — security |
| A10 | SE1-APPLY — owner | | |

Reviewer checklist **C1–C10** = the ten items of main handoff §8, in order (hashes · drafts · preflight · ownership · suites · outside consumers · owner-role control · pin patches · T1 / L2 · separate verdicts).

## 8. Who does what

| | Independent reviewer | Authorized DB operator | Owner / security / accountant | Claude (local only) |
|---|---|---|---|---|
| Recompute hashes, read drafts and tests, run the suites themselves | **yes** | — | — | may re-run to reproduce, never *instead of* the reviewer |
| Run `PREFLIGHT.sql` on staging / production | — | **yes** | authorizes | **never** (no access, no credentials requested) |
| Capture, redact, send the report | — | **yes** | — | — |
| Judge a finding (PASS / FAIL / UNKNOWN meaning), sign a verdict | **yes** | — | — | **never** |
| Approve apply, residual risk, frozen view, pin amendments, D-ORDER | — | — | **yes** | **never** |
| Decide T1, L2, staging migration role | recommends | — | **yes** | — |
| Write and test drafts, packages, patches, preflight, report tool, handoffs; mutation tests; isolated-copy rehearsals; keep S-1 intact | — | — | — | **yes (done)** |
| Rename the Phase 4 migrations (D-ORDER) and regenerate the patches | reviews | — | decides | **yes, after the decision** |
| Commit, push, merge, deploy, apply a migration or role change | — | — | **yes** | **never** |

## 9. Checklists

**Operator checklist (per environment, staging first)**
- [ ] Hold `PREFLIGHT.sql` and `preflight-report.mjs`; both sha256 match §1.
- [ ] Connect with my own credentials via the secret mechanism; none typed into a command.
- [ ] Capture with the §2 command (read-only); no write, no `\copy`, no extra queries.
- [ ] Run once with the migration connection string and once with an ordinary login.
- [ ] Build the report with `preflight-report.mjs`; it did not refuse (if it did: fix at the source, re-run).
- [ ] Send only the report to the reviewer; keep the capture inside the environment; do not edit either.

**Reviewer handoff checklist**
- [ ] Confirm the operator's script and tool hashes equal §1, and the report names `PREFLIGHT.sql`'s sha256.
- [ ] Read the **FAIL** and **UNKNOWN** tables first; any UNKNOWN on `P30` / `P40` / `P41` / `P42` is an open question, not a pass.
- [ ] Compare staging with the §5 expectations; any difference is a finding.
- [ ] Review production only after staging; confirm who owns `security_event` and the tables, and the migration role (`P20`, `P21`).
- [ ] Work the main handoff §8 checklist (C1–C10) and record AL1, SE1 and (if the same person) S-1 verdicts **separately**.
- [ ] Review decision D-ORDER (§6) and the frozen-pin patches.

**Exact next owner action.** Name **(1)** an authorized staging database operator and **(2)** an independent reviewer who did not write, direct or operate this implementation, and **authorize one thing only**: *the operator runs the read-only staging preflight (§2) and sends the redacted report to the reviewer.* Do not authorize production, a migration, a role change or any approval yet. In parallel, record **D-ORDER** (re-stamp the Phase 4 stack, §6) so the Phase 4 promotion cannot break the locked Inventory test.
