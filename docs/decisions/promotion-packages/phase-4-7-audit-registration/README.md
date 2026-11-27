# Audit-registration approval bundle — expenses & other income (PREPARED, NOT APPLIED)

One unapplied, reviewable bundle. **Nothing here changes the live registry or any production service**, and no approval is recorded (`BUNDLE.json` → every approval `recorded: false`).

| File | What it is |
|---|---|
| `registry.patch` | the eight proposed registrations for `common/audit/actions.ts` (adds only; identical to `proposed-migrations/patches/E1-audit-actions-registry.patch`) |
| `pin-amendments.patch` | the two structural pins that say "NOT registered" flipped to "registered exactly as approved" (`expense-audit.structural`, and the audit pin of `promotion-package.structural`) |
| `rehearsal/audit-required.provider.ts.txt` | the ONE binding that turns the audit from NOT_ACTIVATED to REQUIRED (a DI provider) — a review snippet, registered nowhere |
| `rehearsal/expense-audit.registered.rehearsal.integration.test.ts.txt` | the end-to-end rehearsal test (real registry file, real `AuditWriter`, real Nest DI, disposable PostgreSQL); a `.txt`, so the real tree never runs it |
| `rehearse.mjs` | builds an ISOLATED copy (`apps/api/zz-audit-sim`), applies the bundle to the copy, runs the verification, deletes the copy |
| `SECURITY-REVIEW-EVIDENCE.md` | the precise evidence per decision, from measured facts; sign-offs unticked |
| `BUNDLE.json` | manifest: SHA-256 of every artefact, activation flags (all false), the six unticked approvals |

```
node rehearse.mjs registered            # copy + registry patch + pin amendments + rehearsal -> run -> delete
node rehearse.mjs registered+promoted   # the same, with the D -> Z1 -> E1 promotion package ALSO applied in the copy
node rehearse.mjs manifest              # rewrite BUNDLE.json
```

Applying it for real (after the approvals are recorded by humans): `git apply registry.patch pin-amendments.patch`, add the provider as a module, and decide the `audit_log` immutability gap first (`SECURITY-REVIEW-EVIDENCE.md` §7).
