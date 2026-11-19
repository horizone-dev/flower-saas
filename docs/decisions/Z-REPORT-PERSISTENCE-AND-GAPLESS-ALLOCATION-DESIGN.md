# Z-Report persistence, gapless allocation and the close transaction — DESIGN ONLY

Status: **PROPOSED — nothing here is implemented, migrated, wired or approved.** It states what a future, separately approved change must satisfy so that the
verified pure modules (`z-report.ts`, `z-sales-facts.ts`, `z-adjustment.ts`) and the database agree line by line.
A pure in-memory chain proves the _arithmetic and linkage_ of the numbers; it does **not** prove that two concurrent closes on one register can never both take
number _n_. Only the database can, and this document is the contract for it.

## 1. What is proven today (pure, no database)

| Property                                                                                                                  | Where                                | Proof                             |
| ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ | --------------------------------- |
| Deterministic content, canonical bytes, per-register hash chain (`z-report` domain, scope `register:<id>`)                | `finalizeZReport` / `verifyZReport`  | unit + property tests, 39 mutants |
| Gapless numbering **from an explicitly supplied head**; missing / repeated / reordered / tampered / dropped-tail detected | `verifyZChain({from, expectedHead})` | unit tests                        |
| Frozen value shares no memory with its inputs                                                                             | `structuredClone`                    | aliasing tests                    |
| Corrections = linked adjustments bound to the original by number **and** hash, original only read                         | `z-adjustment.ts`                    | unit tests                        |
| Drawer verified against its sources by **identity** (X-Report source check), independent of every sales figure            | `x-report.ts`                        | unit + real-PG                    |

## 2. What only the database can prove (the future change)

### 2.1 Table shape (sketch, not a migration)

`z_report`: `id`, `tenantId`, `companyId`, `branchId`, `posTerminalId`, `cashRegisterId` (FK), `registerSessionId` **UNIQUE** (one Z per session),
`zNumber bigint NOT NULL CHECK (zNumber >= 1)`, `prevHash`, `hash`, `content jsonb` (the frozen canonical report), `closedAt`, `createdByUserId`.
Constraints: `UNIQUE (cashRegisterId, zNumber)`; `UNIQUE (cashRegisterId, prevHash)` (a head can have only one successor); `UNIQUE (hash)`.
`z_adjustment`: `zReportId` FK, `adjustmentNumber`, `prevHash`, `hash`, `content jsonb`; `UNIQUE (zReportId, adjustmentNumber)`.
RLS on both (`tenantId = current_setting('app.tenant_id')`, FORCE).

### 2.2 Allocation — number AND previous hash under one lock

1. Inside the close transaction, `SELECT … FROM cash_register WHERE id = $1 FOR UPDATE` (the **register row** is the serialisation point: one Z at a time per
   register; different registers never block each other).
2. Read the register's head: `SELECT zNumber, hash FROM z_report WHERE cashRegisterId = $1 ORDER BY zNumber DESC LIMIT 1` — _after_ the lock, in the same transaction.
3. Pass `{previousZNumber, previousHash}` to the **pure** `finalizeZReport`; it returns `zNumber = previous + 1` and the link. The database never invents a number.
4. `INSERT` the row. The unique constraints are the backstop: a second writer that somehow bypassed the lock gets `23505` and the transaction rolls back — it can never
   commit a gap or a fork.
5. **Never a sequence.** A `SEQUENCE`/`serial` advances on rollback and would create gaps; gaplessness needs "max + 1 under a lock", not `nextval`.
6. A trigger rejects `UPDATE`/`DELETE` on `z_report` and `z_adjustment` (append-only, immutability enforced in the database, not only in code), and rejects an `INSERT` whose
   `zNumber` is not `previous + 1` or whose `prevHash` is not the current head (defence in depth against a buggy writer).

### 2.3 The close transaction (one transaction, one outbox event)

Order (a single transaction; any failure rolls **everything** back, the session stays open):

1. lock register row → lock session row (`register_session`, fixed order **register → session → movements guard**, matching the existing single lock order);
2. re-read session, count record, ledger, source window **inside** the transaction (no value computed before the lock is trusted);
3. `buildXReport` → `buildZReport` (pure) → refuse on any blocker (`NOT_FINALIZABLE`) — nothing is written;
4. `finalizeZReport` with the head read in 2.2;
5. insert `z_report`; write the CLOSING movement and mark the session `CLOSED` (terminal state; the existing T-1 guards apply);
6. variance (over/short) posting only if the accountant-approved policy exists (S-9) — otherwise a non-zero variance is already a blocker;
7. audit row + outbox event (`cash_register.z_report_finalized`) in the same transaction.

Idempotency: the close takes an `Idempotency-Key` (durable claim ledger, ADR-0022). A replay returns the stored Z; it never allocates a second number.

### 2.4 Corrections

An adjustment is inserted with its own gapless `adjustmentNumber` per original Z under `FOR UPDATE` of the original `z_report` row, using `buildZAdjustment`'s link.
Reversing journal entries are a **separate, approval-gated posting**; the adjustment only stores `reversingEntryRef`.

### 2.5 Verification jobs

Nightly `verifyZChain` per register (segmented from the last anchored head via `from`), plus an externally anchored head (e.g. daily hash in the audit chain) to detect
truncation of the tail — the one thing a self-contained chain cannot prove.

## 3. Required tests when it is built (real disposable PostgreSQL)

- N concurrent closes on **one** register → exactly one succeeds per Z; numbers 1…N gapless; rest rolled back with the session still open.
- Two registers closing concurrently → independent chains, no cross-blocking (timing assertion on lock scope).
- Crash/rollback between steps 3 and 5 → no `z_report`, no CLOSING movement, session OPEN, number not consumed.
- Direct `UPDATE`/`DELETE`/out-of-order `INSERT` rejected by the database for a superuser-less app role.
- Replay with the same `Idempotency-Key` returns the same Z; different key after close → 409.
- `verifyZChain` over the stored rows equals the pure verification of the same objects.
- Tenant/branch isolation probe (cross-tenant read = 0 rows, cross-register insert rejected).

## 4. Explicitly NOT decided here (owner / accountant)

Which documents belong to a shift (the **attribution basis**), the presentation of gross / discount / net, variance posting (S-9), whether corrections may change closed
periods, and the retention of `content jsonb`. See the S5 report for the exact questions.
