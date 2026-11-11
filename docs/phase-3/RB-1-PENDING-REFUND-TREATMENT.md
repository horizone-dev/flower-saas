# RB-1 — treatment of PENDING refunds in the ledger (finding F-3) and the manual-card question (F-9)

- **Status:** documentation for the accountant. **P1 (the treatment below) is what the code does today; nothing here changes policy.** P2 is described
  so the accountant can decide with the exact entries in front of them; it is **not implemented**.
- **Evidence base:** the ledger-oracle test (every refund state, read from the journal tables), the report-impact test (trial balance at each stage),
  the sub-ledger ↔ `PAYMENT_CLEARING` reconciliation (Q3, difference 0 over every legitimate flow), the cut-off test, and a reading of the settlement
  code (F-9, marked as _read, not exercised_).

## 1. P1 — what is implemented: the in-flight refund sits on `ASSET.PAYMENT_CLEARING`

| Event                                 | Journal (source key)                                                                                                               | Effect                                                                                         |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Credit note issued (refund = PENDING) | `anonymous_credit_note`: Dr `REVENUE.SALES` (total − tax) · Dr `LIABILITY.TAX_PAYABLE` (tax) / Cr `ASSET.PAYMENT_CLEARING` (total) | revenue and output tax reversed now; the refund is booked **in flight**; cash / bank untouched |
| CASH refund attested                  | `anonymous_credit_note_refund`: Dr `ASSET.PAYMENT_CLEARING` / Cr `ASSET.CASH_ON_HAND`                                              | the in-flight credit becomes the real cash-out; clearing returns to its prior balance          |
| BANK_TRANSFER refund attested         | same, Cr `ASSET.BANK`                                                                                                              | same                                                                                           |
| Manual CARD / OTHER refund attested   | **no journal**                                                                                                                     | the sale debited clearing; issuance's clearing credit is already the final effect              |
| Refund FAILED                         | **no journal**                                                                                                                     | the amount stays in flight (unallocated) until a replacement line is added and attested        |

**Measured example** (the report-impact test; AED, minor units; a 6 999 sale with 333 VAT, one CASH line; trial-balance closing figures, debit − credit):

| Stage                        | `ASSET.CASH_ON_HAND` | `ASSET.PAYMENT_CLEARING` | `LIABILITY.TAX_PAYABLE` | `REVENUE.SALES` | Trial balance          |
| ---------------------------- | -------------------- | ------------------------ | ----------------------- | --------------- | ---------------------- |
| after the sale               | +6 999               | 0                        | −333                    | −6 666          | 6 999 = 6 999          |
| after **issuance** (pending) | +6 999               | **−6 999**               | 0                       | 0               | 6 999 = 6 999          |
| after **execution**          | 0                    | 0                        | 0                       | 0               | 0 = 0 (fully reversed) |

**What an accountant sees in P1:** while a refund is pending, an **asset** account carries a **credit** balance equal to the refunds in flight. Gross
assets are lower by that amount than under P2 (cash is still in the till and is netted by the clearing credit); net assets are identical.

**Is P1 acceptable?** _For the pilot, with the controls below: yes, as a documented transitional presentation._ It reuses the frozen Task 3b.8
precedent (provider refunds in flight use the same account), needs no chart-of-accounts, mapping or frozen-contract change, and its execution is
proven to net the account back exactly. _As a permanent presentation: the accountant decides_ — it nets an obligation against receivables in transit
(which presumes a right of set-off) and an un-replaced failed refund hides in a generic account.

**Mandatory controls under P1 (all verified by tests):** Q1 (pending list) and Q2 (unallocated credit) reviewed at every period end; **Q3 difference =
0**; the summary's `reconciliation.reconciled = true` and `pendingRefunds.atPeriodEnd` recorded in the close file (§3).

## 2. P2 — a dedicated liability (**not implemented; exact entries for the decision**)

| Event                        | P2 journal                                                                                   | Difference from P1                                                |
| ---------------------------- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Issued                       | Dr `REVENUE.SALES` · Dr `LIABILITY.TAX_PAYABLE` / Cr **`LIABILITY.REFUNDS_PAYABLE`** (total) | the obligation is a liability, never netted against receivables   |
| CASH / BANK attested         | Dr `LIABILITY.REFUNDS_PAYABLE` / Cr `ASSET.CASH_ON_HAND` \| `ASSET.BANK`                     | same economic result                                              |
| Manual CARD / OTHER attested | Dr `LIABILITY.REFUNDS_PAYABLE` / Cr `ASSET.PAYMENT_CLEARING`                                 | **now posts a journal** (P1 posts none)                           |
| FAILED                       | none                                                                                         | the obligation stays visible as a **liability**, where it belongs |

**What P2 requires** (so the decision is informed): a new account in the chart of accounts (seeded per company, with a backfill for existing
companies); a change of the frozen account-key set and of the posting templates (the plan, the repository, the commit-time DB guards of F-4, the
summary and Q3, all re-tested); the manual-card execution gaining a journal; and a migration. It is a **separate, approved change** with its own tests.

## 3. Period-end procedure (cut-off, F-8) — the proposal for the accountant to adopt or change

1. Run the summary for the closing month (company and each branch): require `reconciliation.reconciled = true` and `paymentClearingAtPeriodEnd.reconciled = true`.
2. Record `pendingRefunds.atPeriodEnd` (count, amount): refunds issued but not attested by the end of the last day of the period.
3. For each (Q1): attest, fail, replace, or **accept as accrued** with a note. For each unallocated credit (Q2): replace or accept.
4. Nothing posts into a closed period (a closed period refuses the attestation, and the whole transaction rolls back — tested); an attestation made after
   close posts on its own, later date, so the **in-flight amount at the close is exactly what step 2 recorded**.
5. Keep the Q3 result and the summary for the close file.

**Verified:** a refund issued on day D and attested on D+2 is in flight at the end of D, executed in the period of D+2, and every lens plus the cumulative
clearing tie-out agree with the ledger on both sides of the boundary (the cut-off test).

## 4. F-9 — manual card / other refunds that post nothing, and settlement (_read, not exercised by a test_)

- A manual `CARD_TERMINAL` payment on a walk-in sale **debits `PAYMENT_CLEARING`** (frozen sale journal). The frozen settlement flow **can** clear a
  card-terminal payment: `isPaymentSettlementFinal` treats `CARD_TERMINAL` as final once its whole amount is covered by FINALIZED settlement batches, and
  a finalized batch **credits `PAYMENT_CLEARING` by the gross settlement** (`settlement-finalization.repository.ts`). `OTHER_MANUAL` is never settlement-final.
- Settlement lines have a **closed kind (`SETTLEMENT`)**; there is no refund-aware line.
- **Consequence:** if the original card payment was **never** settled through a batch, a manual card refund's clearing credit simply reverses the
  standing debit (consistent, nets to zero). If it **was** settled, the refund leaves a **standing credit on `PAYMENT_CLEARING`** that no frozen flow
  clears (the processor's lower net settlement would have to be booked outside the system, or by a P2-style change).
- **The accountant must state** how manual card-terminal takings are settled against clearing in the target deployment (criterion S4), and the
  procedure for a refunded, already-settled card payment. **No behaviour was changed.**

## 5. Segregation of duties and attestation (F-5, F-6) — facts, a detective control, options

- **Fact:** `credit_notes:issue` + `refunds:execute` (with step-up) are held together by owner, admin, manager and accountant. The **same user can issue
  a credit note, attest its refund and fail a refund**; the audit trail records each action with the actor. **Q7 lists exactly those lines** (verified
  by a test). An empty Q7 means a second person attested every outcome.
- **Fact:** the attestation is a human claim: the system cannot see the cash or the card terminal. The receipt `reference` (≤ 60 chars) is optional.
- **Options for the owner (none implemented):** (a) accept, with Q7 reviewed periodically; (b) require a **different user** to attest than the one who
  issued (a service-level check, a new 409 `SAME_USER_ATTESTATION_FORBIDDEN`; no migration); (c) require a `reference` for CASH / BANK executions (a DTO
  rule); (d) both. **Safest default for the pilot: (a) with Q7, decided together with the accountant (criterion S9).**
