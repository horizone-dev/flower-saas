# PHASE 4 — CONSOLIDATED OWNER DECISION PACKAGE (cash register, E-5, provisioning, cash in / out, counting)

Status: **FOR DECISION — nothing here is approved, applied, committed, deployed or live.** The "Recommended" column is a recommendation, not a decision.
Three separate authorities are needed and none substitutes for another: **Owner** (business policy and the go / no-go of every amendment),
**Accountant** (what a movement means in the books), **Security** (an independent reviewer; the author of the code may not sign). Every signature
line below is blank.

IDs: `A-1 … E-5` are the questions of `DECISION-SHEET-cash-register-owner-accountant.md`; `E5-O1 … O8 / A1 … A4 / S1 … S4` are those of
`E5-FINAL-APPROVAL-PACKAGE.md`; `PV-1 … PV-6` are of `REGISTER-PROVISIONING-READINESS.md`. They are one set of questions seen from different
sides; the table below states each ONCE.

## 1. What the owner is actually being asked

| Block                                             | Decision                                 | What it unlocks                                     | Migration                      | Frozen amendment  |
| ------------------------------------------------- | ---------------------------------------- | --------------------------------------------------- | ------------------------------ | ----------------- |
| 1 E-5 cash sales / refunds into the drawer ledger | E5-O1 … O8                               | a real shift reconciles and closes                  | none (O8 optional)             | **yes — 7 files** |
| 2 Register provisioning                           | A-1, A-2 (= PV-1 … PV-6)                 | any terminal can have a register at all             | **none** (option A)            | no                |
| 3 Cash in / out                                   | B-1, B-2, C-1 … C-4, D-6 + CIO-1 … CIO-3 | float top-up, safe drop, (payout)                   | 2 (schema, permissions)        | no                |
| 4 Difference at close, approval                   | D-1 … D-5 (accountant + owner)           | close with a shortage / overage                     | 1 (account) + a posting change | no                |
| 5 Counting + terminal selection                   | E-2, E-3, E-4, E5-O4, E5-O5              | count stored in the database; sales during counting | 1 (schema)                     | no                |

## 2. Decisions, with recommendations and consequences

### Block 1 — E-5 (details: `E5-FINAL-APPROVAL-PACKAGE.md`)

| ID         | Decision                                                                           | Recommended                                    | Consequence                                                                                                                         | Migration / frozen |
| ---------- | ---------------------------------------------------------------------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| E5-O1      | mechanism                                                                          | **direct transactional integration** (rule 29) | movement commits or rolls back with the sale / payment / refund; outbox / trigger rejected                                          | no / yes           |
| E5-O2      | refusal policy                                                                     | **`POS_STRICT`**                               | a verified POS terminal needs an open session or the whole sale rolls back (409 `CASH_REGISTER_REFUSED`); card / bank never refused | no / no            |
| E5-O3      | cash with no verified device (Owner Web)                                           | **allowed, no drawer movement**                | not in any drawer ledger; reported by the window reconciliation                                                                     | no / no            |
| E5-O4      | sale while COUNTING                                                                | **refused** (S-2 default)                      | cashier waits for the close                                                                                                         | no / no            |
| E5-O5      | terminal of record                                                                 | **the completing terminal**                    | cash is booked where it is physically taken                                                                                         | no / no            |
| E5-O6      | historical cash                                                                    | **explicit cut-over, no backfill**             | no historical drawer figure changes                                                                                                 | no / no            |
| E5-O7      | the frozen amendment + its pins                                                    | **approve, shipped with the policy OFF**       | see §4 review scope                                                                                                                 | no / **this**      |
| E5-O8      | optional unique index across types                                                 | **defer**                                      | application guarantee stays (advisory lock)                                                                                         | yes / no           |
| E5-A1 … A4 | sub-ledger (no journal), types and signs, zero tolerance, discrepancy blocks close | confirm (accountant)                           | —                                                                                                                                   | —                  |
| E5-S1 … S4 | context-only identity, device ACTIVE at record time, Rule 31, isolation            | confirm (independent security)                 | —                                                                                                                                   | —                  |

### Block 2 — Register provisioning (details: `REGISTER-PROVISIONING-READINESS.md`)

| ID         | Decision                                     | Recommended                                                                                                                                                                                     | Consequence                                                                                                                                                                                                                                                                                                        |
| ---------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A-1 / PV-1 | who creates a register, with which key       | **A: Owner-only routes under the EXISTING `devices:manage`** + step-up + Owner account                                                                                                          | no new key, no migration; the patches now carry a **fail-closed feature gate** (PV-7): applied, the routes still answer 404 until the deployment sets `REGISTER_PROVISIONING_ENABLED=true`. B: a new `cash_register:manage` key = a registry migration. C: lazily at first open = no route, but no audit of intent |
| A-2        | created active; can be deactivated           | **A**: active; deactivate / reactivate routes                                                                                                                                                   | deactivate refused while a session is OPEN / COUNTING                                                                                                                                                                                                                                                              |
| PV-2       | device requirement to provision / reactivate | **yes** (terminal ACTIVE + device ACTIVE)                                                                                                                                                       | a bare or revoked-device terminal cannot get a register                                                                                                                                                                                                                                                            |
| PV-3       | deactivate while COUNTING                    | **refused** (as OPEN)                                                                                                                                                                           | —                                                                                                                                                                                                                                                                                                                  |
| PV-4       | auto-provision on terminal creation          | **explicit only**                                                                                                                                                                               | no side effect on terminal creation                                                                                                                                                                                                                                                                                |
| PV-5       | audit `security` flag                        | **false** (configuration fact)                                                                                                                                                                  | a `security_event` view change would be a migration                                                                                                                                                                                                                                                                |
| PV-7       | provisioning feature gate                    | **yes, fail-closed** — built into both route patches: the routes answer `404 ROUTE_DISABLED` until the deployment sets `REGISTER_PROVISIONING_ENABLED=true` (exact string; anything else = off) | "deployed" and "enabled" become two reversible acts; the owner decides WHEN to enable per environment; no migration                                                                                                                                                                                                |

### Block 3 — Cash in / out (details: `CASH-IN-OUT-ACCOUNTING-READINESS.md`)

| ID    | Decision                                                                                          | Recommended                                                                                                             | Consequence                                                                                                          | Migration        |
| ----- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ---------------- |
| B-1   | separate safe balance in the GL?                                                                  | **no** — drawer and safe are both `ASSET.CASH_ON_HAND`; safe drop / float top-up are **drawer-ledger-only, GL-neutral** | **no new account**; the drawer ledger and the GL cash balance then differ by exactly these types (see §5, rule R4)   | none             |
| B-2   | counter-party for a transfer                                                                      | **no** in V1 (acting user only)                                                                                         | simplest; no second-user acknowledgement                                                                             | none             |
| C-1   | what may be put in                                                                                | **A: only a float top-up from the safe**                                                                                | `CASH_IN` with reason `FLOAT_TOP_UP`; GL-neutral                                                                     | none             |
| C-2   | what may be paid out                                                                              | **A: no ad-hoc payout in V1**                                                                                           | `CASH_OUT` is **not used**; payouts come with the Expense module. B would add `EXPENSE.CASH_PAYOUT` + a coded reason | none / (account) |
| C-3   | reason vocabulary, storage                                                                        | **A: coded list in a new `reasonCode` column with a CHECK, no free text**                                               | evidence on the row, not only in the audit                                                                           | **DRAFT A**      |
| C-4   | sign rule per type                                                                                | **A: enforced by CHECK**                                                                                                | wrong-signed rows impossible even outside the code                                                                   | **DRAFT A**      |
| D-6   | float limits                                                                                      | none in V1                                                                                                              | —                                                                                                                    | none             |
| CIO-1 | source kind of a manual operation                                                                 | **`CASH_OPERATION`, source id = the operation id (idempotency identity)**                                               | no operations table needed                                                                                           | none             |
| CIO-2 | policy values (`requireReason`, `allowedReasonCodes`, `maxAmountMinor`, `forbidNegativeExpected`) | `requireReason: true`, owner-supplied short code list, per-operation limit, `forbidNegativeExpected: true`              | until supplied the policy is `null` and everything is refused                                                        | none             |
| CIO-3 | `SAFE_DROP` becomes writable                                                                      | **yes, as a MANUAL_DRAWER type (negative, reason-coded)**                                                               | follows from B-1 A; a small, tested code change (§6 step 3)                                                          | none             |
| E-1   | permission matrix                                                                                 | **Owner: all six `cash_register:*`; Cashier: open / view / close / cash_in; Manager: none**                             | `cash_register:override` (approver) Owner-only; every key is device-bound                                            | **DRAFT B**      |

### Block 4 — Difference at close (accountant first)

| ID  | Decision                       | Recommended                                                                                                                | Consequence                                          | Migration                        |
| --- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | -------------------------------- |
| D-1 | account for a difference (S-9) | **one account `EXPENSE.CASH_OVER_SHORT`**                                                                                  | the only chart addition in the whole recommended set | **DRAFT C**                      |
| D-2 | posting                        | **at close, same transaction; shortage Dr OVER_SHORT / Cr CASH_ON_HAND, overage the reverse; key `REGISTER_SESSION:<id>`** | today ANY variance blocks the close — this lifts it  | none (code, separately approved) |
| D-3 | who approves                   | **Owner only (`cash_register:override` + step-up) while Manager is disabled**                                              | a variance needs the Owner                           | —                                |
| D-4 | tolerance                      | **none**                                                                                                                   | one minor unit is a difference                       | —                                |
| D-5 | recount / forced close         | recount any number of times, audited; forced close Owner-only, reason `FORCED`                                             | —                                                    | schema (with E-2)                |

### Block 5 — Counting and terminal selection

| ID            | Decision                                                                                                                                                     | Recommended                                                                                                                                                                                                        | Consequence                                                                                                                                               | Migration                                                                                                                                                                |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| E-2           | where the count is stored                                                                                                                                    | **`register_session_count` table (immutable rows, denominations, counter, supervisor, expected vs counted, database-recomputed expected cash) + a close trigger that needs the latest fresh balanced CLOSE count** | the database refuses a close without count evidence; **applying it requires the count repository in the same change** (today's close writes no count row) | **DRAFT D — prepared, validated in a disposable database; detail in `CASH-COUNT-AND-CLOSE-DESIGN.md`** (closing columns on `register_session` deliberately NOT included) |
| CNT-1 … CNT-4 | supervisor ≠ counter; whether a CLOSE count needs a supervisor; a count older than the last movement cannot close (stale); only the session's cashier counts | **yes; no in V1 (a policy input exists); yes; yes**                                                                                                                                                                | attribution and "no cash escapes a close"                                                                                                                 | in DRAFT D                                                                                                                                                               |
| E-3           | blind count                                                                                                                                                  | **yes** — expected / variance returned only after the count is recorded                                                                                                                                            | cashier cannot count to a target                                                                                                                          | none                                                                                                                                                                     |
| E-4 / E5-O4   | what may be recorded while COUNTING                                                                                                                          | **only `ADJUSTMENT` and `CLOSING`, approver only; sales and cash in / out refused**                                                                                                                                | the safe default already in code                                                                                                                          | schema (with E-2)                                                                                                                                                        |
| E5-O5         | terminal of record                                                                                                                                           | **the completing terminal**                                                                                                                                                                                        | an order created on terminal A and completed on B puts the cash in B's drawer                                                                             | none                                                                                                                                                                     |

## 3. Smallest answer set and what it costs

All ★ answers need **exactly three migrations** (DRAFT B permissions, DRAFT A schema, DRAFT C account) **plus** the counting schema (DRAFT D now prepared; its E-2 / E-4 /
D-5 forced-closure columns are not drafted) and **one frozen-contract review** (E-5). Registers need **no** migration. Nothing is posted to the GL until D-2 is approved
AND a close-posting change is separately approved and tested.

## 4. E-5 — exact frozen-pin and review scope (for the INDEPENDENT reviewer)

Patches (`git apply --check` clean on the current tree; apply the two E-5 patches TOGETHER):

| Patch                                       | sha256 (prefix)    | Touches                                                                             |
| ------------------------------------------- | ------------------ | ----------------------------------------------------------------------------------- |
| `E5-cash-sales-wiring.patch`                | `f619ca16c86f4dd1` | 7 frozen files + `cash-register.module.ts` + new `cash-source-wiring.repository.ts` |
| `E5-cash-sales-wiring-tests-and-pins.patch` | `d09df15ea76002ec` | 3 amended pins + the wired suite (16 tests, 1,093 lines)                            |

Frozen production files (every change is one import, one constructor dependency and one call **after** the existing financial write, inside the
existing transaction; with `CASH_SALES_POLICY = OFF` the call returns at once):

| File                                                            | Change                                                           | Reviewer verifies                   |
| --------------------------------------------------------------- | ---------------------------------------------------------------- | ----------------------------------- |
| `sales/sales-application.service.ts`                            | +11 / 0: call after `enqueueSaleCompleted`, origin `SALE_TENDER` | no existing line altered; same `tx` |
| `payments/payment.repository.ts`                                | +16 / −4: capture result kept, call, origin `INVOICE_PAYMENT`    | return value unchanged              |
| `receivables/customer-receipt.repository.ts`                    | +11 / −4: origin `CUSTOMER_RECEIPT`                              | return value unchanged              |
| `receivables/refund.repository.ts`                              | +9 / −4: `REFUND` source                                         | refund keeps its own single journal |
| `sales.module.ts`, `payment.module.ts`, `receivables.module.ts` | one import of `CashRegisterModule` each                          | no cycle (tsc + DI tests)           |

Pin amendments (every changed assertion): **(1)** 3b.9 Checkpoint E — the `SalesModule` imports list gains `CashRegisterModule` (+2 / −1);
**(2)** module-directory pin — two new file names (+2); **(3)** `cash-sales-e5.structural.test.ts` (+98 / −9) — the two "NOT wired" assertions become
"wired EXACTLY like this": four call sites only, each through `cashRegister.recordInTx(tx, …)` inside its own `scoped(async (tx) =>` callback, with
its origin, AFTER the financial write; every other frozen sale / payment / receipt / refund file still unaware of the register; policy default OFF,
caller built only from `requireTenantContext()`, refusal = `CASH_REGISTER_REFUSED` 409; producer inventory (only three `payment` writers; the refund
primitive has one caller). The 218 other 3b.8 / 3b.9 pins pass **unchanged**.

Stacking: the two E-5 patches and `PV-register-provisioning-routes.patch` each apply alone but overlap in `cash-register.module.ts` and the
directory pin, so they are not plainly stackable; the order **E-5 wiring → E-5 pins → `PV-register-provisioning-routes.after-E5.patch`** applies
cleanly and is byte-identical to the verified combined tree. Both PV patches were **regenerated with the fail-closed feature gate** (PV-7) on
2026-11-14: `PV-register-provisioning-routes.patch` `266b2e8bdb12c945` (standalone) and `…after-E5.patch` `099e677b45c5e764`; the E-5 pins patch is now
`d09df15ea76002ec` (the wiring patch is unchanged, `f619ca16c86f4dd1`). Verified: combined E-5 + gated routes 43 files / 1,371 tests; standalone gated routes
43 files / 1,362 tests.

## 5. Cash in / out accounting — minimum requirements and the implementation proposal (nothing executed)

Minimum for the recommended V1 (B-1 A, C-1 A, C-2 A): **no chart addition for cash in / out**; the only addition is `EXPENSE.CASH_OVER_SHORT` for
the close difference (D-1).

Proposed posting rules (accountant decides; **no posting code exists**):

- **R1 — float top-up / safe drop / opening float:** drawer-ledger-only, GL-neutral, no journal.
- **R2 — payout (only if C-2 B):** synchronously in the movement's transaction (rule 18): Dr `EXPENSE.CASH_PAYOUT` / Cr `ASSET.CASH_ON_HAND`, keyed
  `CASH_MOVEMENT:<id>` (unique source key ⇒ re-posting is a no-op), branch / terminal dimensions.
- **R3 — difference at close (D-2):** in the close transaction, one balanced entry keyed `REGISTER_SESSION:<id>`; approver and reason code in the audit.
- **R4 — reconciliation consequence of B-1 A:** the drawer ledger and the GL cash balance differ by exactly the GL-neutral types
  (`OPENING_FLOAT`, float-top-up `CASH_IN`, `SAFE_DROP`); any future X / Z report or cash-to-GL reconciliation MUST exclude them explicitly.
- **R5 — reversal:** movements are append-only; a correction is a reversing movement (opposite sign, its own operation id, source = the original) plus
  a reversing journal where one was posted; never an edit.
- **R6 — Cash Over/Short:** never silently absorbed (rule 20): recorded, reasoned, approved, then posted (D-2 / D-3 / D-4).

Migration proposals (`docs/decisions/proposed-migrations/`; **not in the migrations directory, not applied**):

| Draft                                       | Content                                                                                                                                                                   | Validated (real PostgreSQL with all 53 migrations, executed inside a rolled-back transaction)                                                                                                           |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DRAFT-A-cash-movement-reason-and-sign.sql` | `reasonCode` column + shape CHECK + per-type sign CHECK                                                                                                                   | applies over existing rows; 9 accepted / 9 refused sign cases, CLOSING free, 6 bad reason shapes refused                                                                                                |
| `DRAFT-B-cash-register-permissions.sql`     | 6 registry keys; Owner 6, Cashier 4, others 0; idempotent; RLS re-forced                                                                                                  | counts exact per role, second run adds 0                                                                                                                                                                |
| `DRAFT-C-cash-over-short-account.sql`       | `EXPENSE.CASH_OVER_SHORT` ('5200') per company                                                                                                                            | one per company (16 → 17), idempotent, no journal written                                                                                                                                               |
| `DRAFT-D-register-session-count.sql`        | immutable count table + insert guard (lock, sequence, recomputed expected cash, denomination sum, attribution) + append-only + close guard + RLS + least-privilege grants | 7 tests in a DISPOSABLE database: every guard, immutability, the close rule (no count / spot / shortage / stale refused; fresh balanced allowed; recount), three lock scenarios incl. the sequence race |

Each draft names its **companion TypeScript change** (permission-baseline authorisation + step-up set for B; reference-data array and chart-count pins
for C) which the S0b pins demand in the same reviewed diff; those are not made. `draft-check.test.ts.txt` is the validation harness (5 tests, 5 passed).

## 6. Smallest executable checkpoint AFTER approvals

1. Owner decisions in §2 (at least A-1, E5-O1 … O8, B-1, C-1 … C-4, E-1); accountant sign-off (E5-A*, D-1, D-2); independent security sign-off.
2. Apply the approved migrations (A, B, C as approved) with their companion TypeScript changes; run DB / RLS + drift tests.
3. Make `SAFE_DROP` a `MANUAL_DRAWER` type (CIO-3) and install the approved `CashInOutPolicy`; unit / integration / mutation tests.
4. Apply `PV-register-provisioning-routes.patch`; apply the two E-5 patches (policy OFF) in the stackable order; amend nothing else.
5. Full regression, typecheck, ESLint, build, Prettier; verify CI on the final commit (a separate instruction is needed to commit).
6. Staging: provision registers, open shifts, run real cash sales / refunds / safe drops, run both reconciliations; then — and only then — a separate
   decision flips `CASH_SALES_POLICY` to the approved mode and routes for cash in / out are designed and approved.

## 7. Signatures (all blank)

| Role                            | Name | Decision / date |
| ------------------------------- | ---- | --------------- |
| Owner                           |      | ☐               |
| Accountant (independent)        |      | ☐               |
| Security reviewer (independent) |      | ☐               |
