# Security-review evidence — expense / other-income platform audit registration

**Status: PREPARED, NOT APPROVED.** This is evidence for a reviewer. No sign-off is recorded or implied; every box in §9 is unticked. Nothing here is registered, bound, routed or granted:
the live registry (`apps/api/src/common/audit/actions.ts`) and every production service are unchanged. The registered + `REQUIRED` state exists only inside an isolated copy
(`node rehearse.mjs registered`), against a disposable PostgreSQL. Measured facts below come from that rehearsal (`AUDIT_EVIDENCE_OUT`), not from assumption.

## 1. The eight action names (decision: names)

| Action | resourceType | Written by | When | `before` / `after` |
|---|---|---|---|---|
| `expense_record.created` | `expense` | `ExpenseRepository.createDraft` | a new DRAFT + its CREATE event | none / snapshot + event link |
| `expense_record.submitted` | `expense` | `ExpenseRepository.transition` (SUBMIT) | DRAFT → SUBMITTED | snapshot / snapshot + event link |
| `expense_record.approved` | `expense` | `…transition` (APPROVE) | SUBMITTED → APPROVED; approver stamped | snapshot / snapshot + event link |
| `expense_record.rejected` | `expense` | `…transition` (REJECT) | SUBMITTED → REJECTED; reason is in `expense_event`, not here | snapshot / snapshot + event link |
| `expense_record.paid` | `expense` | `…transition` (PAY) | APPROVED → PAID (a record only: no cash moves, nothing posts) | snapshot / snapshot + event link |
| `expense_category.created` | `expense_category` | `createCategory` | a new tenant-wide category | none / `{nameLength, requiresApproval, active}` |
| `expense_category.active_changed` | `expense_category` | `setCategoryActive` | only when the state really changes | `{active}` / `{active}` |
| `other_income.draft_created` | `other_income` | `OtherIncomeRepository.createDraft` | a new DRAFT (no later action exists) | none / bounded snapshot |

Names are table-aligned domains (`expense_record`, `expense_category`, `other_income`) so they cannot collide with the retired `expense.` / `income.` permission-key families, which the existing pins still forbid in the registry.
Each audit row carries: tenant (from the verified context), company + branch (from the **locked / inserted row**, never a caller), the actor (authenticated user, account type and any platform impersonator — all read from the verified context by the existing writer), and the row's own terminal for expenses.

## 2. Payload allow-list (decision: payload contents)

Allowed keys (an allow-list enforced at run time by `assertBoundedPayload`; a new key is a visible edit of `expense-audit.ts`): `eventId, seq, workflowAction, fromStatus, toStatus, status, amountMinor, currencyCode, currencyExponent, paymentMethod, payeeKind, categoryId, registerSessionId, createdByUserId, approvedByUserId, decidedAt, reasonProvided, accountId, incomeDate, expenseDate, requiresApproval, active, nameLength`.
Values must be primitives of at most 64 characters; amounts are minor units as decimal strings.
**Deliberately excluded** (and tested absent by marker strings): `description`, `reference`, the rejection `reason` text (only `reasonProvided: boolean`; the text lives in the immutable `expense_event`, linked by `eventId`), `idempotencyKey` (client-chosen), `payeeId`, `taxCode`, category **names** (only `nameLength`), income descriptions, any token / secret.
Personal data present: user ids only (pseudonymous), as in every other audit row.

## 3. `security: false` for financial workflow actions (decision: classification)

Facts. `security_event` is a **hard-coded SQL view**: audit rows whose `action` matches `tenant.% | role.% | user.% | provider_credential.% | session.% | IMPERSONATION:%`, plus `login_security_event`; it is readable only by `flower_platform` (the Super-Admin alerting feed). The registry's `security` flag must equal view membership (`actions.test.ts`, build-blocking).
Precedent: every financial-domain action already registered is `security: false` (`settlement.*`, `cash_register.*`, `catalog.*` CRUD, `device.*`).
Measured in the rehearsal: for **every** distinct action in `audit_log`, "appears in the view" equals `isSecurityEventAction`; none of the eight appears; a `tenant.suspend` written by the same writer does (positive control).
Argument for `false`: these are tenant business events reviewed by the tenant's owner / finance staff and by finance audit, not identity / authorisation / secret events for the Super-Admin security feed; it needs no view migration.
Argument for `true` (for `approved` / `paid` at most): approval and payment are separation-of-duties controls, so a fraud review wants them in one place.
**Consequence of choosing `true`:** it is NOT a registry-only change — the view's `LIKE` list would need a migration (otherwise `actions.test.ts` fails). Recommendation: `false` for all eight, and decide a dedicated finance-audit view separately. The decision is the reviewer's.

## 4. PLATFORM-AUDIT-EVENTS coverage (decision: coverage)

Audited today (only on SUCCESS, same transaction): the eight above. `expense_event` is the expense's own history and is **not** a platform audit trail (pinned in code and manifest).
**Not audited** (measured, `coverage.refusals_audited = false`): refused attempts — self-approval (`SELF_APPROVAL`), `MISSING_PERMISSION`, `ILLEGAL_TRANSITION`, `REASON_REQUIRED`, scope-denied (reported as not found), idempotency-key reuse; reads (list / get / history); a no-op category toggle. Precedent for failures: device refusals go to `login_security_event`. A creator trying to approve their own expense is the security-relevant refusal: **decision needed** whether activation must record refusals (and in which table / view).
Not an audit item but adjacent: no outbox event exists for the expense lifecycle (CLAUDE.md §28–29) — a separate checkpoint.

## 5. Activating `REQUIRED` (decision: policy)

Mechanism: one DI provider (`rehearsal/audit-required.provider.ts.txt`); the repositories have **no default** — rehearsal proves that omitting the provider fails at module compile and that a silent `@Optional()` default is caught.
Preconditions: the eight actions registered; allow-list and flag approved; the audit-log gap in §7 decided. Failure semantics (proved with a real `BEFORE INSERT` trigger on `audit_log`): the status change, the event and the audit row all roll back, the idempotency key stays reusable, other expenses are unaffected.
Operational consequence (fail-closed by design): if `audit_log` cannot be written, expense workflow writes are refused. There is a single DEFAULT partition today (`audit_log_default`).

## 6. Transaction boundary (measured)

One scoped transaction (`SET LOCAL ROLE flower_app`, `app.tenant_id`, `app.branch_id`). Rehearsal: the expense row, its `expense_event` and its audit row carry the **same `xmin`** in every step; 8 concurrent approvals → exactly one `expense_record.approved` row and one APPROVE event; replays, refusals and illegal transitions add none; the adapter opens no connection and commits nothing.

## 7. Grants and RLS of `audit_log` (measured) — and one pre-existing gap

| Fact | Measured |
|---|---|
| `flower_app` privileges | SELECT, INSERT, **UPDATE, DELETE** |
| `flower_platform` privileges | SELECT, INSERT, **UPDATE, DELETE** |
| RLS | enabled **and forced**; one policy `audit_log_tenant_isolation`, `USING` and `WITH CHECK` = `tenantId = app.tenant_id` |
| Branch dimension | **none** (so the adapter checks company / branch scope; a foreign-tenant row is refused by `WITH CHECK`) |
| Triggers on `audit_log` | **none** |
| Partitions | `audit_log_default` only |

**GAP (frozen Phase 1/2 schema; not introduced here, not fixed here):** the Phase 1 default privileges give the application role UPDATE and DELETE on `audit_log` and nothing makes it append-only. The rehearsal **proves** it: an application-role transaction updated (`1` row) and deleted (`1` row) its own tenant's audit row; RLS still stops it reaching another tenant's rows. `entryHash` / `prevHash` columns exist but are unwritten (OD-P2-1). Until this is decided, these audit rows are evidence only to the extent that application code is trusted. This is pinned as a test so closing it is a deliberate, visible change. Needs a separate, approved migration (revoke UPDATE / DELETE, append-only + TRUNCATE guards, then the hash chain).

## 8. How to reproduce

`node docs/decisions/promotion-packages/phase-4-7-audit-registration/rehearse.mjs registered` (copy + registry patch + pin amendments + rehearsal test; real writer, real registry file, real Nest DI) and `… registered+promoted` (the D → Z1 → E1 promotion package also applied in the copy). `AUDIT_EVIDENCE_OUT=<file>` collects the measured facts above.

## 9. Sign-off (NOT RECORDED — each is a human, outside this repository's tooling)

- [ ] Action names (§1)   - [ ] Payload allow-list (§2)   - [ ] `security: false` classification (§3)
- [ ] Coverage / refused-attempt auditing (§4)   - [ ] `REQUIRED` activation (§5)   - [ ] `audit_log` immutability decision (§7)
