# CASH IN / CASH OUT — what is built, and the minimum approvals before anything is reachable

Status: **components built, inert, unapproved.** No route, no permission grant, no approved policy, no migration, no GL account, no posting.
Everything in §3–§5 is a PROPOSAL for the owner and accountant; nothing is signed. Owner approval, independent accountant sign-off and
independent security sign-off are three separate things and none substitutes for another.

## 1. What exists (all under `apps/api/src/modules/cash-register/`)

| File                        | Role                                                                                                                                                                                                                                                                                                                                                                                  |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cash-movement-classes.ts`  | PURE closed classification of the 11 documented movement types: `SESSION_INTRINSIC` (OPENING_FLOAT, CLOSING), `SOURCE_BACKED` (CASH_SALE, CUSTOMER_PAYMENT, CASH_REFUND — E-5), `MANUAL_DRAWER` (CASH_IN, CASH_OUT), `BLOCKED_PENDING_POLICY` (EXPENSE, SAFE_DROP, REGISTER_TRANSFER, ADJUSTMENT); proposed sign rules; the sign is derived from the TYPE, never supplied by a caller |
| `cash-in-out.ts`            | PURE decision `decideCashInOut(input, facts, policy)`; no policy ⇒ `POLICY_NOT_APPROVED` for everything                                                                                                                                                                                                                                                                               |
| `cash-in-out.repository.ts` | `CashInOutRepository.record` — one transaction: per-operation advisory lock → device ACTIVE → session `FOR UPDATE` → ledger → decision → ONE `cash_movement` row + ONE audit row. **No caller, no route**                                                                                                                                                                             |
| `common/audit/actions.ts`   | `cash_register.cash_in_recorded` / `cash_out_recorded` (drawer facts, `security:false`)                                                                                                                                                                                                                                                                                               |
| `cash-register.module.ts`   | registers the repository and `CASH_IN_OUT_POLICY = null` (the shipped state)                                                                                                                                                                                                                                                                                                          |

### What the code guarantees (each tested; 21 unit + 13 integration + 8 structural; 23/23 mutants caught)

- **Amount and sign:** the caller supplies a positive magnitude; CASH_IN is stored `+`, CASH_OUT `−` (a stored row obeys `isSignConsistent`).
- **Currency:** code and exponent must equal the session's (the company's).
- **Types:** only CASH_IN / CASH_OUT are writable; EXPENSE / SAFE_DROP / REGISTER_TRANSFER / ADJUSTMENT are refused `TYPE_BLOCKED_PENDING_POLICY`;
  CASH_SALE / CUSTOMER_PAYMENT / CASH_REFUND / OPENING_FLOAT / CLOSING are refused `TYPE_NOT_SUPPORTED` — so **no manual path can double-count a
  sale, a refund or the float** (the source-backed set is pinned to equal the E-5 set).
- **Reason and actor:** a reason is a short CODE (`^[A-Z][A-Z0-9_]{1,31}$`), never free text; required / restricted only if a policy says so. The actor
  is the verified device-bound cashier of the session; another cashier is refused.
- **State:** only an OPEN session takes cash; CLOSED and COUNTING are refused (COUNTING = the undecided S-2 default).
- **Duplicates:** the operation id is the idempotency identity (source kind `CASH_OPERATION`, source id = operation id): a replay is one movement (even after
  the session closed); the same id with another type / amount is a conflict; 6 concurrent attempts give one row and one audit row.
- **Expected cash:** the ledger's Σ signed rows excluding CLOSING (unchanged); float + sale + payment − refund + in − out reconciles to the unit, the source
  reconciliation stays consistent, and the drawer closes at zero variance.
- **Concurrency:** a movement serialises with the register close on the session row (it waits for a close in flight, then is refused); 5 concurrent
  cash-outs against a drawer that holds 4 of them: exactly 4 succeed (when the policy forbids a negative drawer).
- **Isolation:** tenant, terminal, device, actor and scope come from the verified request context; another terminal's / cashier's / branch's / company's /
  tenant's context can put nothing in a drawer; a blocked or revoked device stops cash at once.
- **No accounting effect:** no journal entry, no posting, no GL account (fingerprint-verified).

## 2. Findings while building

- The movement row has **no reason column** (S1: "NO free-text reason column"): a reason can only live in the audit evidence until a schema decision is taken.
- The database encodes **no per-type sign rule** except "the float is never negative": the sign rule lives in application code until a CHECK is approved (§3).
- With one cash account in the frozen chart, a transfer between two drawers of the same branch is a **dimension** change (terminal), not a new account.

## 3. Proposed amendments — SEPARATE, EXACT, NOT APPLIED

### 3.1 Schema (a migration — needs owner approval; none created)

```sql
-- DRAFT. Not applied. Hardening + the one missing column; no data rewrite.
ALTER TABLE "cash_movement"
  ADD COLUMN "reasonCode" TEXT,
  ADD CONSTRAINT "cash_movement_reason_code_shape_chk"
    CHECK ("reasonCode" IS NULL OR "reasonCode" ~ '^[A-Z][A-Z0-9_]{1,31}$'),
  ADD CONSTRAINT "cash_movement_sign_chk"
    CHECK (CASE "type"
             WHEN 'CASH_SALE' THEN "amountMinor" > 0
             WHEN 'CUSTOMER_PAYMENT' THEN "amountMinor" > 0
             WHEN 'CASH_REFUND' THEN "amountMinor" < 0
             WHEN 'CASH_IN' THEN "amountMinor" > 0
             WHEN 'CASH_OUT' THEN "amountMinor" < 0
             ELSE true END);
-- optional (E5-O8): CREATE UNIQUE INDEX ... ON cash_movement ("tenantId","sourceKind","sourceId")  -- one movement per source across types
```

Consequence: existing rows all satisfy the sign CHECK (E-5 is not wired; only OPENING_FLOAT rows exist). Rollback: drop the constraints / column.

### 3.2 Permissions (a registry migration — needs owner approval; none created)

`cash_register:cash_in`, `cash_register:cash_out` and `cash_register:override` already exist in the TypeScript vocabulary and the S0b baseline but are
**policy-disabled and not registered**. Proposal: register `cash_in` / `cash_out`; grant to Manager (and Cashier only if the owner wants it);
`cash_register:override` = the approver for amounts above a threshold; step-up required for money movements (CLAUDE.md rule 13). All three keep the
`cash_register:` prefix, so the registered-device guard demands a verified device (correct for a drawer operation).

### 3.3 Policy (values, no migration)

`CashInOutPolicy { requireReason, allowedReasonCodes, maxAmountMinor, forbidNegativeExpected }` — the owner / accountant supply the values; until then
`null`. Recommendation: `requireReason: true`, a short approved code list, a per-operation limit, `forbidNegativeExpected: true`.

## 4. The accounting questions (the accountant decides; nothing below is posted today)

A manual cash movement is not one thing. What it **means** decides whether it is a drawer transfer, an expense, income or a settlement, and each has a
different journal. The frozen chart has 16 accounts and only ONE cash account (`ASSET.CASH_ON_HAND`); it has **no** safe, petty-cash, payout,
other-income, owner-contribution, supplier-payable, cash-over/short or general expense account.

| Meaning of the movement                       | Candidate journal (proposal)                                  | New accounts needed                        |
| --------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------ |
| Float top-up / drawer-to-drawer (same branch) | none — a dimension move on `ASSET.CASH_ON_HAND` (terminal)    | none                                       |
| Drawer → safe / bank drop; safe → drawer      | Dr/Cr `ASSET.CASH_ON_HAND` ↔ a safe / cash-in-transit account | `ASSET.CASH_SAFE` (or in-transit)          |
| Expense paid from the drawer                  | Dr an expense account / Cr `ASSET.CASH_ON_HAND`               | `EXPENSE.<petty>` (per category)           |
| Owner contribution / withdrawal               | Dr cash / Cr (Dr) an equity account                           | `EQUITY.OWNER_CONTRIBUTION` / `…_DRAWINGS` |
| Supplier payout                               | Dr payable / Cr cash                                          | a payable account (Phase 5)                |
| Cash over / short at close                    | Dr/Cr `EXPENSE.CASH_OVER_SHORT` vs cash (S-9)                 | `EXPENSE.CASH_OVER_SHORT`                  |

Questions to settle (each unsigned): (1) which meanings are in scope for V1; (2) are petty cash / safe real accounts or just dimensions; (3) **posting
timing** — synchronous with the movement (CLAUDE.md rule 18 for "cash movement") in the same transaction; (4) **reversal rule** — movements are
append-only, so a correction is a reversing movement (opposite sign, its own operation id, source = the original) plus a reversing journal, never an
edit; (5) **approval** — who approves above what amount, recorded in the audit evidence; (6) **cash over/short** — still blocked by S-9: today ANY
variance blocks the close; (7) how a manual in/out is shown on an X / Z report (out of scope here).

## 5. Approval and audit requirements (proposal)

Audit: one row per movement, written in the movement's transaction (built); bounded evidence — ids, type, minor-unit strings, reason CODE, expected
cash before / after; no free text, token or device material. Approval: an approver identity is **not stored** anywhere today (no column); either the
audit evidence carries it, or §3.1 grows an `approvedByUserId`. Both are the owner's call.

## 6. What stays blocked

Any route, any permission grant, any posting, any new account, EXPENSE / SAFE_DROP / REGISTER_TRANSFER / ADJUSTMENT, cash over/short, approvals,
Owner-Web management screens. The components can be switched on only by: owner approval of §3.1–§3.3, accountant sign-off of §4, independent security
sign-off, then a route (not designed here) — and never before.

## 7. Verification (see the checkpoint report for the full numbers)

Unit 21/21; integration 13/13 (real PostgreSQL + Redis); structural 8/8; mutation 23/23 caught; DB/RLS 273/273; tsc, ESLint, Prettier, build clean.

## 8. FINANCIAL-INTEGRITY VERIFICATION of the proposed cash in / safe drop / float / difference treatment (2026-11-14)

**Question:** can the recommended treatment (B-1 A, C-1 A, C-2 A, D-1 … D-2) introduce double counting or an incorrect GL reconciliation?
**Answer, proven on code and on real journals:** not as modelled — provided the accountant approves the choices in §9. Nothing was posted, activated or
created to prove it.

`cash-gl-bridge.ts` (pure, no defaults, no posting) classifies every ledger row into exactly one of: **GL-neutral** (opening float; a float-top-up
`CASH_IN`; a `SAFE_DROP`, only if the accountant answers "no separate safe account"), **own journal** (cash sale / customer payment / cash refund — posted once
by the sale / payment / refund transaction itself), **excluded** (`CLOSING`), or **unresolved** (everything the accountant has not decided). The identity
it checks:

```
drawer expected cash = GL-neutral rows + own-journal rows          (a PARTITION — property-tested on 300 random ledgers × 3 answer sets)
GL cash net of the session = own-journal rows + a posted close difference (if any)
```

| Risk                                                              | Result                                                                                                                                   |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| The opening float counted twice (once as float, once as money in) | the float is a drawer-only COUNT (GL-neutral); a float posted to the GL shows as `UNEXPLAINED_GL_DIFFERENCE` of exactly the float        |
| A sale or refund counted twice (journal + manual movement)        | manual path cannot write source-backed types (class pin); a sale posted twice shows as an unexplained difference of exactly its amount   |
| A float top-up posted as income                                   | detected: the GL moved by an amount no row explains; with the accountant undecided it is `UNRESOLVED` and the session does NOT reconcile |
| A close difference posted AND recorded as an adjustment           | flagged `DIFFERENCE_AND_ADJUSTMENT_BOTH_PRESENT` and does not reconcile                                                                  |
| A close difference altering the expected cash                     | impossible by construction: a difference is not a ledger row; expected cash is unchanged by it                                           |
| "reconciles" true while a flag is raised                          | closed by a test the mutation sweep demanded (a surviving mutant was found and fixed)                                                    |

**On REAL journals** (`cash-gl-reconciliation.integration.test.ts`, real PostgreSQL + Redis, the frozen sale and refund routes): a shift with a 200.00
float, a 20.00 cash sale, a 50.00 float top-up and a 7.00 cash refund — the GL cash account moved by **exactly +20.00 − 7.00** (the sale's journal and the
refund's journal, each once); the drawer's expected cash differs from the GL by **exactly the float + the top-up**; the same shift with the accountant
undecided does not reconcile (the top-up is unresolved); closing the drawer on the exact count posted **nothing** (GL cash and the journal fingerprint
unchanged). `SAFE_DROP` is not writable yet (blocked by the class pin until CIO-3), so its neutrality is proven in the pure bridge only.

Mutation: 23 / 23 mutants of the count record and the bridge caught (one survivor found by the sweep was a genuine test gap — fixed and re-caught).

## 9. UNRESOLVED ACCOUNTING CHOICES — for the INDEPENDENT accountant (none decided, none invented)

| #     | Question                                                                                                                                                                                                                                     | Recommended (not approved)                                   | If undecided                                |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------- |
| UA-1  | Does the GL carry a separate safe / cash-in-transit balance (B-1)?                                                                                                                                                                           | no — drawer and safe are both `ASSET.CASH_ON_HAND`           | `SAFE_DROP` stays UNRESOLVED and unwritable |
| UA-2  | Which `CASH_IN` reasons are GL-neutral transfers (C-1)?                                                                                                                                                                                      | only `FLOAT_TOP_UP`                                          | every `CASH_IN` is UNRESOLVED               |
| UA-3  | Is a safe drop / float top-up between a drawer and a safe in the SAME branch really GL-neutral, or must the safe's custody be visible (control, audit)?                                                                                      | neutral, with the drawer ledger + audit as the custody trail | as UA-1                                     |
| UA-4  | `CASH_OUT` / payout (C-2): in scope for V1? where booked?                                                                                                                                                                                    | not in V1; later with the Expense module                     | `CASH_OUT` stays UNRESOLVED                 |
| UA-5  | Meaning of `EXPENSE`, `REGISTER_TRANSFER`, `ADJUSTMENT`                                                                                                                                                                                      | defer                                                        | all UNRESOLVED and unwritable               |
| UA-6  | Close difference (D-1 … D-4): account (`EXPENSE.CASH_OVER_SHORT`), signs, timing (in the close transaction), key (`REGISTER_SESSION:<id>`), tolerance (none), approver, reason                                                               | as in the decision package                                   | any difference refuses the close (today)    |
| UA-7  | **Carry-over:** the next session's opening float is a COUNT of cash already in the drawer; any gap between the previous session's closing count and the next float is unexplained cash movement between sessions. Should the system flag it? | yes — a read-only flag, no posting                           | undetected                                  |
| UA-8  | Cash-to-GL reconciliation and X / Z reports must exclude the GL-neutral types (float, top-up, safe drop); confirm the exclusion list                                                                                                         | confirm                                                      | reports would not reconcile to the GL       |
| UA-9  | Reversal of a manual movement (R5): a reversing movement with its own operation id, never an edit                                                                                                                                            | confirm                                                      | —                                           |
| UA-10 | A cash refund can take the ledger's expected cash below zero (the refund is physical truth); should the refund path be allowed to, or refuse (E5 policy `forbidNegativeExpected` applies to cash-out only today)?                            | allow + flag                                                 | silent negative drawer                      |
| UA-11 | Posting timing for any future posting: synchronous in the movement's transaction (rule 18)                                                                                                                                                   | confirm                                                      | —                                           |

Independent accountant sign-off: ☐ NOT SIGNED. Owner approval: ☐ NOT GIVEN. Independent security sign-off: ☐ NOT SIGNED.
