# Promotion package — DRAFT D + DRAFT Z1 + DRAFT E1 (PREPARED, NOT APPLIED)

A reviewed, **unapplied** diff. Nothing here is a real migration; nothing in `packages/db/prisma/migrations`, `schema.prisma`, the drift fixtures or `frozen-baseline.ts` was edited.
`PACKAGE.json` is the manifest: every source, candidate, rollback, model and fixture is listed with its SHA-256, and **every approval is `recorded: false`**.

## Order (explicit, and enforced by the database)

| # | Step | Sources (verbatim) | Adds |
|---|------|--------------------|------|
| 1 | D  | `proposed-migrations/DRAFT-D-register-session-count.sql` + `D-hardening-addendum.sql` | `register_session_count`; the close guard on `register_session`; **privilege hardening + TRUNCATE guard** |
| 2 | Z1 | `proposed-migrations/DRAFT-Z1-z-report-storage.sql` | `z_report`; replaces D's close guard (a close needs its Z) — **fails fast without D** |
| 3 | E1 | `proposed-migrations/DRAFT-E1-expenses-and-other-income.sql` | `expense_category`, `expense`, `expense_event`, `other_income` (needs neither D nor Z1) |

Candidate migration directories carry PLACEHOLDER names that fix the relative order and sort after `20261204120000_phase_4_device_permissions`; the real names are chosen at promotion.

## What a promotion changes (all in ONE reviewed change, only after the approvals are recorded)

1. copy the three `migrations/*` directories into `packages/db/prisma/migrations/` (content unchanged: their hashes are authorised in step 4);
2. append `schema-additions.prisma` to `packages/db/prisma/schema.prisma` after one newline (six scalar-only models, already in `prisma format` shape);
3. replace the two drift fixtures with `amended-fixtures/*` (baseline +27 `DropForeignKey` statements, review +27 `BY_DESIGN`, 0 open findings; same as `drift-amendment.json`);
4. `git apply pin-amendments.patch` — authorises the three migrations and six models in `frozen-baseline.ts` and amends the pins that named the newest migration or said "no such table exists yet" (each becomes "exists only through the promoted migration");
5. retire the two package tests listed in `PACKAGE.json` → `retiredAtPromotion`.

Rollback: `rollback/3-e1.sql`, then `2-z1.sql`, then `1-d.sql` (safe only while the tables hold no rows; afterwards they are evidence).

## What stays blocked even after promotion
No route, no permission grant (`expense:*` / `income:*` are granted to no role), no GL posting, no cash movement (`EXPENSE` stays `BLOCKED_PENDING_POLICY`), no category → GL mapping, no PAYABLE. Each is an approval in `PACKAGE.json`. `expense_event` is an in-transaction history and does **not** replace the platform `audit_log` events activation must write.

## Verified by
`packages/db/test/phase4-promotion-package.integration.test.ts` (real `prisma migrate deploy` of real migrations + candidates; candidates ≡ drafts; drift = baseline + the amendment; exact privileges; stage-by-stage rollback; wrong order refused) and `apps/api/src/verification/promotion-package.structural.test.ts` (consistency, separation, inertness, unticked approvals). The patch was proven in an isolated copy of the tree with the promotion applied: all 37 structural files (1,394 tests) pass.

Regenerate (local, reviewed act; refused when `CI` is set): `UPDATE_PROMOTION_PACKAGE=1 pnpm --filter @flower/db exec vitest run test/phase4-promotion-package.integration.test.ts`.
