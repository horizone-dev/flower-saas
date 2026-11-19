# D-ORDER — owner decision sheet: migration timestamp conflict (Phase 4 stack × Inventory stack)

**Status: OWNER DECISION PENDING — nothing is renamed, applied or approved.** Inventory S-1 stays **BLOCKED** and none of its 34 locked files is touched by anything below. Background and proofs: `SECURITY-OPERATOR-AND-REVIEWER-HANDOFF.md` §6 and `apps/api/src/verification/phase4-inventory-migration-ordering.structural.test.ts`.

## The decision in one sentence
Re-stamp the five Phase 4 migration names (D, Z1, E1, AL1, SE1) into the 24-hour gap *before* Inventory step H, so the locked Inventory order test stays green after Phase 4 is promoted and every environment applies migrations in one consistent order: **real → Phase 4 → Inventory**.

## Why a decision is needed
The locked Inventory order test calls `checkManifest(manifest, <real migrations folder>, …)`. Inventory step H is stamped `20261205120000`; the Phase 4 stack is stamped `20261205120000 … 20261205120400`. As soon as **any** Phase 4 migration is promoted under its current name the locked checker returns exactly one violation — `BEFORE_EXISTING_MIGRATIONS:H` — and the locked test fails the build (proved after every one of the five promotion steps). That happens at **Phase 4 promotion**, before Inventory is activated. The two stacks have no SQL dependency in either direction.

## The five proposed changes (names only; SQL content and its sha256 are unchanged)

| Step | Current name | Proposed name |
|---|---|---|
| D | `20261205120000_phase_4_s5_register_session_count` | `20261204130000_phase_4_s5_register_session_count` |
| Z1 | `20261205120100_phase_4_s5_z_report_storage` | `20261204130100_phase_4_s5_z_report_storage` |
| E1 | `20261205120200_phase_4_7_expenses_and_other_income` | `20261204130200_phase_4_7_expenses_and_other_income` |
| AL1 | `20261205120300_phase_4_audit_log_immutability` | `20261204130300_phase_4_audit_log_immutability` |
| SE1 | `20261205120400_phase_4_security_event_isolation` | `20261204130400_phase_4_security_event_isolation` |

All five sort after the newest real migration (`20261204120000_phase_4_device_permissions`) and before Inventory step H (`20261205120000_inventory_company_costing_method`); no real migration is stamped inside that gap. With them the locked checker is silent after every promotion prefix and for the final folder (real + Phase 4 + all nine inventory steps).

## What changes, and what does not
- **Changes (mechanical):** 5 migration directories under the three package folders and the names inside **15 files** — `promotion-package.structural.test.ts`, `helpers/promotion-package.ts`, `phase4-audit-log-hardening.integration.test.ts`, `phase4-security-event-isolation.integration.test.ts`, `rehearse.mjs`, the three `PACKAGE.json`, the three `pin-amendments.patch`, the AL1 and SE1 `README.md`, and the two handoff documents. The patch and manifest hashes are then regenerated and the full-stack rehearsal re-run.
- **Does not change:** any `migration.sql` content or hash; any Inventory S-1 file (the order manifest, its checker, the drafts); any frozen production file; any approval (all 21 approvals in the three package manifests are unrecorded, so none is invalidated).

## Prerequisite for the rename — confirm nothing has applied these names
Renaming a migration that an environment has **already applied** would corrupt that environment's history. None of the five has been applied by this work, but the owner must confirm for staging and production. The only query outside `PREFLIGHT.sql` this needs (bookkeeping names, no tenant data; run with the **migration** login, read-only):

```sql
SELECT migration_name FROM _prisma_migrations WHERE migration_name >= '20261204' ORDER BY 1;
```
Expected: `20261204120000_phase_4_device_permissions` or older, and **no** `202612051…` row. If any of the five names appears, **stop**: Option A must not rename an applied migration and the plan needs rework.

## Options

| | Option | Consequence |
|---|---|---|
| **A (recommended)** | Re-stamp the Phase 4 stack (above) | Locked Inventory test stays green; one consistent order everywhere; the rename touches only Phase 4 package artefacts |
| B | Activate Inventory first, Phase 4 second | Works on `prisma migrate deploy` (measured: an earlier-sorting migration is applied after later ones **without error**) but leaves an **out-of-order history**: an existing environment applies H, I … S then Phase 4, a fresh database applies H, D, Z1, E1, AL1, SE1, I … S; the "newest migration" pins would disagree with the history |
| C | Edit the Inventory manifest's stamps | **Not allowed** — edits a locked S-1 file and reopens S-1 |

**If no decision is made:** nothing breaks today (nothing is promoted), but the first Phase 4 promotion will fail the locked Inventory order test.

## After the owner chooses A (what Claude does — locally, no commit)
1. Rename the five directories and update the 15 files; regenerate the AL1 / SE1 / D-Z1-E1 patch and manifest hashes and the share manifest (`SHARE-MANIFEST.json`, whose paths contain the names).
2. Re-run the Inventory-ordering test, all three package structural suites, the real-PostgreSQL stack tests and every rehearsal variant, and confirm the S-1 manifest is still 34/34 unchanged.
3. Report the diff for review. Applying it to a real tree, committing, or promoting remains the owner's action.

## Owner decision (unticked — the owner records it, not Claude)
- [ ] D-ORDER — Option A, re-stamp the five Phase 4 migrations as proposed
- [ ] D-ORDER — Option B (activate Inventory first)
- [ ] D-ORDER — another ordering (specify)
- [ ] I have confirmed no environment has applied any of the five current names
