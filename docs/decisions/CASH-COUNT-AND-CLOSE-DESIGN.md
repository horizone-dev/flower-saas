# CASH COUNT & CLOSE — minimum safe persistence design (DRAFT; nothing applied)

Status: **pure model built and tested; schema is a DRAFT migration validated in a disposable database; no repository, route, permission, posting or
migration exists.** Nothing here is approved. Owner approval (E-2 / E-3 / E-4 / D-5), accountant sign-off (the difference) and independent security
sign-off are three separate things; every signature in `PHASE-4-OWNER-DECISION-PACKAGE.md` is blank.

## 1. What exists today (verified before this checkpoint)

A _count_ is audit evidence only: `cash_register.count_recorded` carries the denominations, expected, counted and variance, and changes no state. A
_close_ runs `COUNTING → CLOSED` in one transaction only when the submitted count equals the ledger (any difference — one minor unit — refuses it);
nothing is stored except the audit row and the status. So there is **no queryable count history, no supervisor, no database proof that a closed session
was ever counted**, and a close can be requested with a count the database never saw.

## 2. The minimum safe design

| Requirement                                    | Pure model (`count-record.ts`, tested)                                                                                                                                          | Draft schema (`DRAFT-D-register-session-count.sql`, validated)                                                                                                                                                      |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Denomination-based count records               | `buildCountRecord`: lines validated by the shared `sumDenominations` (≤ 64 lines, no duplicate / bad / negative), exact subtotals through `Money`, largest first                | `denominations JSONB` (array ≤ 64) and a trigger that proves `Σ denomination × count = countedMinor`, no duplicate, `denomination > 0`, `0 ≤ count ≤ 1,000,000`                                                     |
| Cashier and supervisor attribution             | `countedByUserId` must be the session's cashier; `supervisorUserId` optional, **never equal to the counter**; a CLOSE count needs a supervisor only if the policy input says so | `countedByUserId` / `supervisorUserId` FKs to `user`, same-tenant check, `supervisor <> counter` CHECK, counter = session cashier (trigger)                                                                         |
| Immutable count history                        | `validateHistory` / `verifyCountRecord`: contiguous 1..n, one currency, every record self-consistent — tamper detection                                                         | append-only table (UPDATE / DELETE trigger + privileges revoked), unique `(tenantId, registerSessionId, seq)`, `seq = previous + 1` enforced under the session lock                                                 |
| Expected vs actual cash                        | expected = the ledger's Σ signed rows excluding CLOSING (the existing rule; the float is counted once)                                                                          | the trigger **recomputes** the ledger sum and refuses a count whose `expectedMinor` differs — a client cannot forge the expectation                                                                                 |
| Cash shortage / overage                        | `varianceMinor = counted − expected`, `SHORTAGE` / `OVERAGE` / `BALANCED`; **measured only** — never posted, accepted or absorbed                                               | `varianceMinor = countedMinor − expectedMinor` CHECK; no posting, no account                                                                                                                                        |
| Concurrent count and close protection          | `decideCloseFromHistory`: close only on the **latest**, **CLOSE**, **fresh** (expected = the ledger now), **balanced** count                                                    | a count locks the session row `FOR UPDATE` (the lock a close and every other count take); a close trigger refuses without a latest balanced, fresh CLOSE count; a movement after the count makes it stale (recount) |
| Tenant / company / branch / terminal isolation | scope comes from the locked session                                                                                                                                             | composite FK to `register_session` proves company, branch, terminal, register **and currency**; RLS enabled + forced with the branch-GUC clause                                                                     |

## 3. What the database draft proves (real PostgreSQL, all 53 migrations; 7 tests)

Table, the three triggers and least-privilege grants exist (`flower_app`: SELECT + INSERT only), RLS forced · a valid count is stored with the right
figures and each violation is refused (wrong sequence, forged expected cash, wrong denomination sum, duplicate / zero / negative line, a counter who is not
the cashier, self-verification, a supervisor of another tenant) · the history cannot be updated or deleted, and a CLOSED session takes no count · the close
is refused with no count, with a SPOT count, with a shortage and with a STALE count, and allowed on a fresh balanced CLOSE count, including after a
recount · locks: a count in flight blocks a second count, a movement and a status change; a close in flight blocks a count; the loser of a race on the
same sequence is refused once the winner commits. Run in a throw-away database; nothing touched the project database; the migrations directory is unchanged.

## 4. Application changes the draft REQUIRES (not made)

The existing close flow writes no count row, so applying Draft D alone would make every close fail by design (the close trigger). It must be applied
together with: a count repository that inserts the `register_session_count` row inside the existing locked transaction (count → record; close → record
the CLOSE count then `COUNTING → CLOSED`); the Prisma model and drift-ratchet entry; amendments to the cash-register structural pins and to the
register-session integration tests; and the E-3 blind-count change (the count route stops returning `expected` / `variance` until the count is
recorded). These are the "next implementation checkpoint" after approval.

## 5. Open decisions (recommendations only)

| ID        | Decision                                                  | Recommended                                                    | Why it matters                                                                           |
| --------- | --------------------------------------------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| E-2       | store the count in the database (this table)              | **yes**                                                        | the database can then refuse a close without evidence                                    |
| CNT-1     | a supervisor may never be the counter                     | **yes**                                                        | no one verifies their own count                                                          |
| CNT-2     | a CLOSE count needs a supervisor                          | **no in V1** (policy input exists)                             | the owner sets it per company later                                                      |
| CNT-3     | a count older than the last movement cannot close (stale) | **yes**                                                        | otherwise cash taken after the count escapes the close                                   |
| CNT-4     | only the session's cashier counts                         | **yes** (today's rule)                                         | count attribution                                                                        |
| D-1…D-5   | how a shortage / overage is accepted, approved and posted | **accountant first**                                           | until decided, ANY difference refuses the close (the one trigger that decision replaces) |
| E-3 / E-4 | blind count; what may be recorded while COUNTING          | blind: yes; COUNTING: ADJUSTMENT / CLOSING by an approver only | prevents counting to a target                                                            |

## 6. What this does NOT do

It does not accept a difference, post a variance, create a GL account, add a permission, change a route, or touch the frozen sale / payment / receipt /
refund code. The pure model and the bridge are used by no production code (structural pin). The draft is not in `packages/db/prisma/migrations`.
