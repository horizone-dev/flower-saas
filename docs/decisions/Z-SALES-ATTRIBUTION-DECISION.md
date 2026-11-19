# Z-Report sales attribution — recommended choices, exact sign-offs (PENDING FORMAL APPROVAL — NOTHING APPROVED)

Status: **RECOMMENDED CHOICES, NOT APPROVED DECISIONS.** The owner's preferred policy (D-A1…D-A5 below) is recorded here as the recommendation to be formally
approved. Nothing in this document is approved, implemented as policy, activated or wired. The shipped state is `attributionPolicy = null`, which makes every
Z-Report **non-finalizable** (`SALES_ATTRIBUTION_UNAPPROVED`). The tick boxes in §5 and §7 are for the named approvers only; the engineering side does not tick them.

Scope: _which financial documents belong to which register shift on a Z-Report, and which can never be attributed to a drawer._ It does **not** define gross
sales, discount presentation, variance posting (S-9) or the activation of persistence — see §6.

## 1. The recommended choices (the owner's preferred policy)

- **D-A1 — Sales.** Sales attribution uses the order's authoritative terminal and `invoice.issuedAt`. The civil `invoiceDate` (and the posting date derived from it)
  is **preserved, unchanged**, for the existing accounting and tax reports: the shift window is an _additional_ authority, never a replacement.
- **D-A2 — Conflicting terminal evidence.** A sale is **not silently attributed** to a terminal when the creation and completion terminal evidence conflict. It is
  shown apart (neither terminal), and it blocks.
- **D-A3 — Refunds.** A cash refund belongs to the **executing** cash register, evidenced by the actual `CASH_REFUND` movement — never automatically the original
  sale's drawer. Other refund methods have no drawer and stay unattributed.
- **D-A4 — Credit notes and receipts.** Without authoritative terminal evidence they **remain unattributed**.
- **D-A5 — Fail closed.** Missing or conflicting sources, **and overlapping register sessions**, fail closed: the verifier refuses and the Z is not finalizable.

## 2. Checked against the frozen contracts (file references are to this repository)

| #    | Choice                                                      | Frozen-contract check                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Verdict                                                                                                                                                                                                                                                                                                                                                                                                          |
| ---- | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D-A1 | order terminal + `issuedAt` window; `invoiceDate` preserved | `order.posTerminalId` is set once from the creating session (`order.repository.ts:323`) and pinned by the issuance trigger (`20260920120000_orders_invoice_numbering`: `posTerminalId IS NOT DISTINCT FROM OLD`). The sale journal's terminal **dimension** is that same value (`walk-in-sale-journal.repository.ts:150,243`) and its `accountingDate` is `invoice.invoiceDate` (`:249`), the civil date of `issuedAt` in the company accounting timezone (`invoice-issuance.repository.ts` ~546). The frozen reports (`sales-financial-report*.ts`, `tender-totals-report.ts`) read the posting date and are **unchanged**: no non-test reporting, orders, sales, payments or receivables file was edited; the new reader never reads `invoiceDate` for a window (pinned). | **Consistent.** Caveat disclosed: the frozen reports' period unit is a civil **date**, a shift is an **instant** window.                                                                                                                                                                                                                                                                                         |
| D-A2 | conflict ⇒ not silently attributed                          | **Completion terminal evidence exists in the frozen data:** the audit row `invoice.issued`, written inside the issuance transaction, carries the _executing_ session's `posTerminalId` (`invoice-issuance.repository.ts:583`, `audit.writer.ts:55`). Creation evidence is `order.posTerminalId`. They can legitimately differ (order created on A, completed on B).                                                                                                                                                                                                                                                                                                                                                                                                         | **Consistent, and testable.** Implemented: an invoice whose two terminals differ is its own partition `CONFLICTING_TERMINAL_EVIDENCE`, in neither terminal, in the branch window, and the facts carry the blocking issue `TERMINAL_EVIDENCE_CONFLICT`. Missing completion evidence is **not** a conflict (§5 Q-1). A terminal-less creation is `NO_TERMINAL` and is never attributed to the completing terminal. |
| D-A3 | cash refund ⇒ the `CASH_REFUND` movement's drawer           | `refund` has **no** terminal; its source payment points at the original sale. `cash_movement` carries `registerSessionId`, `posTerminalId`, `occurredAt`; the E-5 recorder already refuses a source created before the session opened (`cash-movement-recorder.repository.ts:178`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | **Consistent.** Cash drawer membership is the **row**, not a time window.                                                                                                                                                                                                                                                                                                                                        |
| D-A4 | credit notes / receipts unattributed                        | `credit_note` has no terminal and no executing-device field; `invoice → order → terminal` is the **origin sale's** terminal, not the executor. A `CUSTOMER_RECEIPT` payment has no order.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | **Consistent**: those partitions are information only (`ATTRIBUTION_MODEL`, pinned and verified).                                                                                                                                                                                                                                                                                                                |
| D-A5 | fail closed incl. **overlapping sessions**                  | The database already allows at most one unresolved session per register **and** per user (S1) and one register per terminal. But the session row stores **no close instant**: a Z whose window end ran past the next session's opening would silently mix two shifts.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | **Consistent; gap closed:** the reader counts other sessions of the same register / terminal opened inside the window (or unresolved from before it) → `OVERLAPPING_SESSIONS`, a blocking issue, and the verifier refuses. DRAFT-Z1 enforces the same rule in the database at Z insert.                                                                                                                          |

**Not established by any frozen contract** (so each needs the formal approval, never a default): that `issuedAt` (not `invoiceDate`) defines "in the shift"; that the
order's creating terminal attributes a sale; that a sale and its cash may sit in different drawers without being a defect.

## 3. Exact sign-offs required — 8 owner, 5 accountant, 1 independent security review (nobody has signed; engineering signs none)

| ID   | Who                                                                   | Decision                                                                                                                                                                              | Evidence it rests on                                                                                                  |
| ---- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| O-1  | Owner                                                                 | D-A1 sales attribution: order terminal + `issuedAt` window; `invoiceDate` preserved                                                                                                   | §2; pinned (the reader never reads `invoiceDate`)                                                                     |
| O-2  | Owner                                                                 | D-A2 conflicting creation / completion terminal evidence is never silently attributed                                                                                                 | §2; real-PostgreSQL test (conflict bucket + blocker)                                                                  |
| O-3  | Owner                                                                 | D-A3 a cash refund belongs to the executing register (its `CASH_REFUND` movement)                                                                                                     | §2                                                                                                                    |
| O-4  | Owner                                                                 | D-A4 credit notes / receipts without authoritative terminal evidence stay unattributed                                                                                                | §2; `ATTRIBUTION_MODEL`                                                                                               |
| O-5  | Owner                                                                 | D-A5 missing / conflicting sources and overlapping sessions fail closed                                                                                                               | §4; DRAFT-Z1 no-overlap guard                                                                                         |
| O-6  | Owner                                                                 | **S-9 variance policy:** may a closing difference be accepted; who approves, up to what amount; step-up MFA (rule 13); who holds the `z_report:*` permissions (policy-disabled today) | DRAFT-Z1 stores an exact approval by someone other than the counter; today's rule (DRAFT D) is "no difference closes" |
| O-7  | Owner                                                                 | Replace DRAFT D's zero-variance close guard by the Z-based close (a session can no longer close without its Z)                                                                        | §8.2 promotion rehearsal: only the close gets stricter                                                                |
| O-8  | Owner                                                                 | Activate Z persistence and shift closing (a separate, later step)                                                                                                                     | §8                                                                                                                    |
| A-1  | Accountant                                                            | A shift window on `issuedAt` is a **presentation** of the same documents; period / VAT / revenue reporting stay on `invoiceDate` / posting date                                       | §2                                                                                                                    |
| A-2  | Accountant                                                            | Net-of-discount convention (3b.9-ACC) stays in the Z: no "gross sales"; discounts apart; recorded tax                                                                                 | frozen contract                                                                                                       |
| A-3  | Accountant                                                            | How a closing difference is **posted** (Cash Over/Short, DRAFT C) — DRAFT-Z1 stores the approved variance and posts nothing                                                           | DRAFT C, DRAFT-Z1                                                                                                     |
| A-4  | Accountant                                                            | Correction method for a closed Z: linked adjustment + reversing entries; the original is never rewritten                                                                              | `z-adjustment.ts`                                                                                                     |
| A-5  | Accountant                                                            | Presentation of cross-drawer sales, conflicting-evidence invoices and unattributed credit notes / non-cash receipts (the choices in §5)                                               | §5                                                                                                                    |
| SR-1 | Independent security / technical reviewer (not owner, not accountant) | DRAFT-Z1: explicit grants (SELECT + INSERT only), RLS, lock order register → session, deferred constraint, replaced close guard, TRUNCATE closure, D → Z1 promotion order             | §8                                                                                                                    |

## 4. What is implemented, read-only and approval-independent (all inert)

| Condition (D-A2 / D-A5)                                                                                                     | Detected by                                                                                                                           |
| --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| creation vs completion terminal conflict                                                                                    | sales-facts reader (`invoice.issued` audit evidence) → partition `CONFLICTING_TERMINAL_EVIDENCE` → issue `TERMINAL_EVIDENCE_CONFLICT` |
| overlapping sessions of one register / terminal                                                                             | reader → `overlappingSessions` → issue `OVERLAPPING_SESSIONS`                                                                         |
| cash payment / refund / receipt without its drawer movement, or a different value, or a movement without its source         | X-Report source check (`SOURCE_MOVEMENTS_MISSING`, `SOURCE_CHECK_INCONSISTENT`)                                                       |
| truncated reads, null tax snapshots, currency mix, unknown tender / status, duplicates, credit-note split, status breakdown | sales-facts issues                                                                                                                    |
| window / scope different from the one the candidate froze                                                                   | source verifier `SOURCE_SCOPE_MISMATCH`                                                                                               |
| every issue above on re-read                                                                                                | source verifier `SOURCE_FACTS_INVALID` → **refuses** (no verdict)                                                                     |

## 5. Exact approve / reject choices (all UNTICKED — the owner and accountant choose; the recommendation is option A of each)

**Q-1 — an order created on a terminal and completed by a session with NO terminal evidence (e.g. an owner token): is that a conflict?**

- [ ] **Approve A** — it is **not** a conflict: attribute to the creating terminal and disclose it (implemented today; the audit row has no terminal, so there is nothing to conflict with).
- [ ] **Approve B** — it **is** a conflict: own bucket, blocks finalization until resolved (one SQL condition + tests; will block every owner-completed terminal order).
- [ ] **Reject both / other:** ____________

**Q-2 — an invoice with NO creating terminal (back-office / owner order): where does it appear?**

- [ ] **Approve A** — in the **unattributed block** of every shift whose window contains its `issuedAt`, and in the branch-window total, **never in a terminal's totals** (implemented today).
- [ ] **Approve B** — **excluded** from every shift Z and reported only by the branch / day reports (the Z then shows only terminal-attributed sales; nothing is lost, it is just not on a Z).
- [ ] **Reject both / other:** ____________

**Q-3 — a cross-drawer sale (order terminal ≠ the terminal of the sale's own cash movement; detectable only once E-5 writes sale movements):**

- [ ] **Approve A** — a **fact, not a defect**: both figures are shown, each under its own authority (sale by order terminal, cash by movement); detection is built with E-5.
- [ ] **Approve B** — a **blocker**: the Z cannot be finalized until the two terminals agree (also needs E-5; will block a legitimate "order on till 1, paid at till 2").
- [ ] **Reject both / other:** ____________

## 6. Explicitly NOT decided here

Gross-sales / contra-discount presentation (rule 20), the S-9 variance policy itself and its posting, and the activation of persistence, the close route and E-5.

## 7. Approval record (approvers complete — engineering does not tick)

- [ ] O-1 · [ ] O-2 · [ ] O-3 · [ ] O-4 · [ ] O-5 · [ ] O-6 · [ ] O-7 · [ ] O-8 (owner)
- [ ] A-1 · [ ] A-2 · [ ] A-3 · [ ] A-4 · [ ] A-5 (accountant)
- [ ] SR-1 (independent security / technical reviewer)
- [ ] Q-1 A / B · [ ] Q-2 A / B · [ ] Q-3 A / B (§5)
- Decided by: ____________ Date: ____________

## 8. Evidence for the reviewers (SR-1, O-7, O-8)

### 8.1 Grants and default privileges of DRAFT-Z1 (checked explicitly)

- **Finding.** The Phase 1 migration runs `ALTER DEFAULT PRIVILEGES … GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO flower_app` (and `flower_platform`, also
  `FOR ROLE flower_migrate`). Every new table therefore starts with UPDATE and DELETE for both application roles.
- **The "equivalent" INSERT-grant mutant.** The first draft revoked only UPDATE / DELETE and then re-granted SELECT, INSERT. Removing the INSERT grant changed nothing
  _because the default already grants INSERT_ — so the mutant was equivalent in behaviour. **It concealed no exploitable access today** (UPDATE / DELETE were revoked, and
  the append-only trigger refuses them for every role regardless), **but it exposed a design weakness:** the access matrix silently depended on the default. A later default
  such as TRUNCATE or REFERENCES would have widened it unseen, and the explicit grants were decorative.
- **Hardening (in DRAFT-Z1).** `REVOKE ALL ON "z_report" FROM PUBLIC, flower_platform, flower_app`, then `GRANT SELECT, INSERT` — those two statements are now the **only**
  access. A statement-level `BEFORE TRUNCATE` trigger closes the one operation row triggers cannot see (owner / superuser).
- **Proof (disposable PostgreSQL).** An exact privilege matrix test: `flower_app` and `flower_platform` hold exactly SELECT, INSERT; `flower_migrate` holds all; every other
  `flower_*` role and PUBLIC hold nothing; a control table without the revoke _does_ inherit UPDATE (the premise); TRUNCATE is refused for the owner.
- **Same pattern in DRAFT D** (`REVOKE UPDATE, DELETE` only): apply the identical one-line hardening when D is promoted. D is left untouched here.

### 8.2 D and Z1 promoted together — frozen session rules not weakened

- **Order is enforced:** DRAFT-Z1 refuses to run unless DRAFT D is applied (a guard at its top); proven on a database without D.
- **One transaction, fully reversible:** D + Z1 applied in one transaction and rolled back leave no table, function or trigger behind.
- **Same battery, before and after:** 18 frozen-rule probes (born OPEN; CLOSED terminal and never deleted; only the three status edges; no movement into a CLOSED session;
  immutable identity and float; one unresolved session per register and per user; exactly one OPENING_FLOAT; append-only ledger) give **identical outcomes** on the migrated
  database before and after the promotion. No frozen guard trigger is dropped or replaced; the promotion only **adds** the close guard.
- **Only the close becomes stricter, by design:** no count → refused; a count but no Z → refused; a Z but no CLOSED session at commit → refused; the proper sequence → closes.
  Ledger semantics are untouched (expected cash excludes CLOSING; a stale count still blocks).
- **The rehearsal can detect a weakening:** a mutant that disables one frozen trigger inside the promotion is caught (§8.3).

### 8.3 Verification of this package (disposable PostgreSQL only; nothing applied)

Results are recorded in the S5 report: storage suite, promotion rehearsal, SQL / store / TypeScript mutation sweeps and the wide regression.
