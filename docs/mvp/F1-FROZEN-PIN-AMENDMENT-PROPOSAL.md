# F-1: frozen-pin amendment proposal (NOT applied)

**2026-11-18 · Status: PROPOSAL FOR OWNER DECISION. Nothing here is approved or applied.** `system-roles.ts` is unchanged, no migration was added, no pin was edited in any repository. The measurements were made in a disposable worktree at clean `origin/main` `ea56cff` and then discarded. Companions: `DECEMBER-APPROVAL-PACKAGES-2026-11.md` (§3), `DECEMBER-ALPHA-INTEGRATION-SEQUENCE.md`.

## 1. The six frozen pins that F-1a trips

F-1a (`DRAFT-F1-system-roles.patch`, +2 lines) adds read-only `catalog:view` to the `cashier` and `sales` role templates. It changes the SHA-256 of `apps/api/src/modules/platform/system-roles.ts` from `977d2e6b…14f0` (frozen) to `18a49b3e…fe2c`. Six Task 3b.10 structural pins hold the frozen hash as a literal and fail on any edit:

| Pin file (`apps/api/src/modules/reporting/`) | Line | Test                                                                                      |
| -------------------------------------------- | ---- | ----------------------------------------------------------------------------------------- |
| `task-3b10-checkpoint-a-structural.test.ts`  | 227  | the permission registry and the default role templates are byte-unchanged                 |
| `task-3b10-checkpoint-b-structural.test.ts`  | 200  | no migration 50, no schema change, no permission change, no role-template change          |
| `task-3b10-checkpoint-c-structural.test.ts`  | 223  | same, plus no new permission key                                                          |
| `task-3b10-checkpoint-d-structural.test.ts`  | 215  | same                                                                                      |
| `task-3b10-checkpoint-e-structural.test.ts`  | 229  | same                                                                                      |
| `task-3b10-checkpoint-f-structural.test.ts`  | 176  | no migration 50, no schema change, no permission-registry change, no role-template change |

Measured on clean `main` with F-1a applied: structural suites **685 of 691 pass; exactly these six fail**. Behavioural suites are unaffected (provisioning 11, order controller 224, sales controller 153, payment-advance 17, customer-account-read 27, reporting controller 21 all pass).

## 2. Minimal amendment (proposed, unapplied)

Replace the six literals with the post-F-1a hash and add a one-line comment pointing here. Nothing else changes: no assertion is removed or loosened, and the pins still fail for **any** other edit of `system-roles.ts`.

- Patch: `docs/decisions/proposed-migrations/patches/F1-six-pin-hash-amendment.patch` (6 files, 12 insertions, 6 deletions; file SHA-256 `c35e3138c3f73879ab9d002299212a1f63fc02824171accb54da8e4ae12f8a93`). It applies on top of `DRAFT-F1-system-roles.patch` on clean `main`.
- Proof, with F-1a and the amendment applied in a disposable tree: **structural 15 files, 691/691**. Tightness check: adding one further permission to the cashier template still fails the first pin.

## 3. The data migration candidate (kept, unapplied)

`DRAFT-F1-cashier-sales-catalog-view.sql` (SHA-256 `3b1c28d4…406`, unchanged) stays in `docs/decisions/proposed-migrations/`, **not** in `packages/db/prisma/migrations`. On a disposable database it passed 3/3 (existing tenants repaired; only the `cashier` and `sales` role keys changed; a custom role untouched; FORCE RLS restored; a rerun is a no-op; it also runs as the non-bypass `flower_migrate` role once that role owns the two tables, as it does in the real environment).

**Adding it as a real migration has a larger pin footprint than the six hashes.** Measured by placing the draft as a throwaway migration folder in a disposable tree: **12 failures in 11 structural files**, the six above plus five Task 3b.9 pins (`task-3b9-checkpoint-b … f-structural.test.ts`), each asserting "exactly 49 migrations, the last is the frozen Task 3b.8 one". PR #41 (migration 50) already amends exactly those 11 files through its own `withoutAuthorizedMigrations` list (`phase3b-authorized-additions.ts`), and Phase 4 carries a separate `frozen-baseline.ts` mechanism; #41 itself notes the two are "reconciled when the branches merge". A second migration must therefore be sequenced against #41, not added independently.

**Recommendation for the December alpha: do not add the migration.** The alpha uses newly provisioned dummy workspaces, and new workspaces receive `catalog:view` from the template (F-1a). The data migration only matters for a workspace provisioned before F-1a, and none exists in the alpha. This removes the migration approval and the five sales pins from the December critical path. If a pre-existing workspace ever needs the grant, the owner can authorise the candidate then, after #41. This is a recommendation, not an approval.

## 4. Options for the owner

| #   | Option                                                                                          | Pins touched                 | Approvals                                                | Notes                                                                                                                                                                   |
| --- | ----------------------------------------------------------------------------------------------- | ---------------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A   | **F-1a + six-hash amendment now** (recommended); no migration                                   | 6                            | owner (frozen pins) + security (permission grant)        | No schema or migration change. Phase 4 slice 7 later replaces the six literals with `frozenSystemRolesSha()`; the lines are the same ones, so the rebase is mechanical. |
| B   | Wait for the Phase 4 baseline (slice 3/4/6/7) and ship F-1a + the F-1b baseline record together | 6 (replaced by the baseline) | owner + security                                         | Slower: the baseline and slice 7 are not on `main`. Cannot be tested on `main` today.                                                                                   |
| C   | A, plus the data migration                                                                      | 11                           | A, plus a migration approval, and sequencing against #41 | Only if a pre-existing workspace needs the grant.                                                                                                                       |

## 5. What approval is requested

Owner and security reviewer, for option A: the read-only `catalog:view` grant to `cashier` and `sales`, and the six one-line hash updates, naming hashes `977d2e6b…14f0 → 18a49b3e…fe2c`. No approval is recorded by this document.
