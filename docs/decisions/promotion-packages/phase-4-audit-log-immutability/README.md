# `audit_log` immutability hardening (AL1) — PREPARED, NOT APPLIED

An unapplied security-hardening package. **Nothing here is a real migration**; `packages/db/prisma/migrations`, `schema.prisma`, the drift fixtures and `frozen-baseline.ts` are unchanged and every approval in `PACKAGE.json` is `recorded: false`.

| File | What it is |
|---|---|
| `docs/decisions/proposed-migrations/DRAFT-AL1-audit-log-immutability.sql` | the draft (source of truth): revoke + exact grants, append-only row guard, TRUNCATE guards, `ENABLE ALWAYS`, self-check |
| `migrations/20261205120300_phase_4_audit_log_immutability/migration.sql` | the candidate (banner + draft), generated |
| `rollback.sql` | restores the previous — vulnerable — state exactly |
| `pin-amendments.patch` | STACKED on the D / Z1 / E1 promotion: authorises the migration in `frozen-baseline.ts`, moves the "newest migration" pins, amends the legacy isolation test |
| `compat.mjs` | runs EXISTING platform tests (unchanged) against databases hardened with the draft |
| `SECURITY-REVIEW-EVIDENCE.md` | measured evidence, residual risks, separate decisions; sign-offs unticked |
| `PACKAGE.json` | manifest: SHA-256 of every artefact, activation flags (all false), approvals, separate decisions |

Order: independent of D / Z1 / E1 in SQL; its pin amendments are stacked after that promotion (promote it first, or regenerate the pins). Applying it needs the recorded approvals first.
Verified by `packages/db/test/phase4-audit-log-hardening.integration.test.ts` (15 tests, real `prisma migrate deploy` over existing audit rows) and `apps/api/src/verification/audit-log-hardening-package.structural.test.ts`.
