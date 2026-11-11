# RB-1 — accountant reconciliation package (`PAYMENT_CLEARING`, pending refunds, manual-card settlement, period-end balances)

- **Status:** evidence and procedures for the accountant. **No accountant sign-off is recorded in this document, none is implied, and the sign-off form
  (§8) is blank.** No accounting policy is decided here: where a choice exists it is stated as a choice with its consequences. Nothing in this package changes
  the code.
- **Provenance of every number:** each worked example is produced by a test that reads the **journal tables directly** (not the feature's own code) and
  asserts the figures below; the queries are executed by a test. Amounts are AED minor units (fils).
- **Companion documents:** `RB-1-PENDING-REFUND-TREATMENT.md` (P1 / P2 entries), `RB-1-ACCOUNTANT-CONTROL-QUERIES.sql` (Q1–Q8),
  `PHASE-3B-CLOSURE-EVIDENCE.md` (§4.2, criteria S1–S13).

## 1. The accounts RB-1 touches

| Account                  | Normal balance | What posts to it                                                                                                  | RB-1's effect                                                                                        |
| ------------------------ | -------------- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `REVENUE.SALES`          | credit         | every sale (`walk_in_sale`, `invoice_ar`)                                                                         | **debited** by `total − tax` when a credit note is issued (net-of-discount convention)               |
| `LIABILITY.TAX_PAYABLE`  | credit         | output VAT of sales and charges                                                                                   | **debited** by the credited tax (the sale's own frozen tax) at issuance                              |
| `ASSET.PAYMENT_CLEARING` | debit          | manual card / other takings (sale debit), provider settlements (credit), provider refunds in flight, **and RB-1** | **credited** by the full credit total at issuance; **debited** when a cash / bank refund is attested |
| `ASSET.CASH_ON_HAND`     | debit          | cash takings, cash payouts                                                                                        | **credited** when a CASH refund is attested                                                          |
| `ASSET.BANK`             | debit          | bank takings, settlements, bank payouts                                                                           | **credited** when a BANK_TRANSFER refund is attested                                                 |

## 2. Worked example E1 — one sale, fully reversed, mixed tenders (all states)

Sale: **10 499** = 9 999 net + 500 VAT, paid **9 499 cash + 1 000 manual card**. Full credit note, refund lines **CASH 9 499** and **CARD_TERMINAL 1 000**.
Figures are the net effect (debit − credit) of **this sale's own journals plus its credit note's journals**, read from the journal tables at each state.

| State                                     | `REVENUE.SALES` | `TAX_PAYABLE` | `CASH_ON_HAND` | `PAYMENT_CLEARING` — this sale, all its journals | `PAYMENT_CLEARING` — RB-1 contribution only | What the books say                                                            |
| ----------------------------------------- | --------------- | ------------- | -------------- | ------------------------------------------------ | ------------------------------------------- | ----------------------------------------------------------------------------- |
| after the sale                            | −9 999          | −500          | +9 499         | +1 000                                           | 0                                           | normal sale; the manual card takings sit in clearing                          |
| **S0 issued, everything PENDING**         | 0               | 0             | +9 499         | **−9 499**                                       | **−10 499**                                 | revenue and tax reversed; the whole refund is in flight                       |
| **S1 cash attested** (partially executed) | 0               | 0             | 0              | **0**                                            | **−1 000**                                  | cash has left; only the card line is in flight (it cancels the sale's +1 000) |
| **S2 card line FAILED**                   | 0               | 0             | 0              | 0                                                | −1 000                                      | **unchanged**; the 1 000 is owed and unallocated                              |
| **S3 replacement card line attested**     | 0               | 0             | 0              | 0                                                | −1 000                                      | manual card posts nothing; the credit and the sale's own debit cancel         |

_(The RB-1 column is what Q3 reconciles to the documents: −(10 499 − 9 499) = −1 000 from S1 on. The "this sale" column also contains the sale's own +1 000
manual-card debit, which is a different journal — Q8 shows the contributions separately.)_ **Verified by:** the ledger-oracle test; every journal balances at every
step; the sale journal plus the credit-note journals net to exactly 0 on every account at the end.

## 3. `PAYMENT_CLEARING` — what it must reconcile to, and how

1. **The account (all sources)** — the trial balance. Run **Q8** for the composition **by source kind**: `walk_in_sale` (takings), `SETTLEMENT_BATCH`
   (settlements), `anonymous_credit_note` (refunds in flight), `anonymous_credit_note_refund` (cash / bank attested), and the frozen receivables flows
   (`refund`, `customer_receipt_payment`). The Σ of Q8 equals the account's balance.
2. **The RB-1 contribution to it** — must equal the documents: expected = −(Σ credit-note totals − Σ **executed** cash / bank refunds) (**Q3**, difference must
   be **0**; the summary's `paymentClearingAtPeriodEnd` is the same tie-out cumulative to the end of any period).
3. **Everything else in the account** is outside RB-1: the accountant ties it to the card-terminal batch reports and the provider statements as before.

**What RB-1 guarantees:** (a) the RB-1 contribution always equals the documents (database guards at commit + the detective Q3); (b) a cash / bank refund can
leave the in-flight balance only with an exact journal; (c) nothing else in the clearing account is touched.
**What RB-1 does not and cannot do:** know whether the card terminal or the processor actually refunded the customer (§5).

## 4. Pending-refund liability at a period end

**Definitions (all from the summary and Q1 / Q2):**

| Item                                | Meaning                                                                                            | Source                                              |
| ----------------------------------- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| **Pending at period end**           | refund lines of notes issued up to the end date that were still unresolved at the END of that date | `pendingRefunds.atPeriodEnd` (count, amount)        |
| **Unallocated credit**              | credit still owed because a FAILED line was not replaced                                           | Q2; `refundsOfNotesIssuedInPeriod.unallocatedMinor` |
| **In-flight balance in the ledger** | the RB-1 contribution to `PAYMENT_CLEARING` at that date                                           | `paymentClearingAtPeriodEnd.glMinor` (= Q3 actual)  |

**How the books present it today (P1):** inside `ASSET.PAYMENT_CLEARING` as a **credit**, netted against receivables in transit. A pending cash refund and a
pending manual-card refund look the same; a failed, unreplaced refund is indistinguishable from a pending one **in the ledger** (the summary and Q1 / Q2 separate
them). **The alternative (P2)** — a dedicated liability — is documented with exact entries in `RB-1-PENDING-REFUND-TREATMENT.md` §2 and is **not implemented**.
**A period-end presentation without any code change** (for the accountant to judge, not adopted here): a **manual reclassification journal** at the period end
moving the in-flight amount to a liability account, reversed on day 1 — it needs a liability account that the chart of accounts does not contain today, and it
is a policy of the accountant's firm, not of this system.

## 5. Manual card / other refunds and settlement — a measurement (F-9)

**Worked example E3 (test-backed; the settlement journal is _emulated_ with the shape of the frozen batch finalisation — it is not the frozen code):**

| Step                                                                                     | `PAYMENT_CLEARING` | `BANK`  | `REVENUE.SALES` / `TAX_PAYABLE` |
| ---------------------------------------------------------------------------------------- | ------------------ | ------- | ------------------------------- |
| Sale **10 499** paid by **manual card terminal** (sale journal debits clearing)          | **+10 499**        | 0       | −9 999 / −500                   |
| The card payment is **settled through a batch** (Dr BANK / Cr CLEARING, gross 10 499)    | **0**              | +10 499 | −9 999 / −500                   |
| Customer **refunded**: credit note issued (Cr CLEARING 10 499; revenue and tax reversed) | **−10 499**        | +10 499 | 0 / 0                           |
| Manual card refund **attested** (posts **nothing**)                                      | **−10 499**        | +10 499 | 0 / 0                           |

**Result:** a **standing credit of 10 499 on `PAYMENT_CLEARING`** and the 10 499 still in the bank. In reality the processor will net the refund from a later
settlement (or the terminal paid it out of the merchant's balance); **no frozen flow records that**: settlement lines have a closed kind (`SETTLEMENT`) with no
refund-aware line. If the card payment had **not** been settled through a batch, the refund's credit simply reverses the standing debit (the account nets to 0).

**The accountant must state:** (i) how manual card-terminal takings are settled against clearing in the target deployment (through batches, or booked by hand);
(ii) the procedure for a refunded, **already-settled** manual card payment. **Options, none implemented:** (O1) a manual journal when the processor nets the
refund (`Dr PAYMENT_CLEARING / Cr BANK` for the netted amount); (O2) a rule that manual card refunds are only taken for **unsettled** payments (a policy; would
need a check); (O3) a refund-aware settlement line in the frozen settlement flow (a frozen-contract change). **Safest default for the pilot:** O1 as an operating
procedure, with Q8 reviewed at every close.

## 6. Period-end procedure (a proposal for the accountant to adopt or change)

| #   | Step                                                                                                                      | Expected result                                                                    |
| --- | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| 1   | Run the **summary** for the closing month (company, then each branch)                                                     | `reconciliation.reconciled = true`; `paymentClearingAtPeriodEnd.reconciled = true` |
| 2   | Run **Q3**                                                                                                                | `difference_minor = 0`                                                             |
| 3   | Run **Q8**; tie every non-anonymous contributor to its external statement                                                 | Σ rows = the trial-balance balance of `PAYMENT_CLEARING`                           |
| 4   | Run **Q1** (pending) and **Q2** (unallocated); for each line: attest, fail, replace, or **accept as accrued with a note** | every line has a recorded disposition                                              |
| 5   | Record `pendingRefunds.atPeriodEnd` (count, amount) and the in-flight balance                                             | amounts agree with Q1 and the ledger                                               |
| 6   | Review **Q7** (same user issued and attested) and **Q5** (executed refunds by day, for the cash count)                    | reviewed, exceptions noted                                                         |
| 7   | For manual card / other refunds executed in the period: list them and apply the §5 procedure                              | each has a settlement disposition                                                  |
| 8   | File the summary JSON, Q1–Q8 output and the dispositions in the close file                                                | —                                                                                  |

## 7. Reconciliation worksheet (to be completed by the accountant at each close)

| Line | Item                                                                | Source                        | Amount | Agrees? |
| ---- | ------------------------------------------------------------------- | ----------------------------- | ------ | ------- |
| A    | `PAYMENT_CLEARING` per trial balance                                | trial balance                 |        |         |
| B    | Σ of Q8 by source kind                                              | Q8                            |        | A = B   |
| C    | of which anonymous refunds in flight                                | Q3 actual / summary `glMinor` |        |         |
| D    | expected from the documents                                         | Q3 expected                   |        | C = D   |
| E    | pending lines at period end (count / amount)                        | summary `atPeriodEnd`         |        |         |
| F    | unallocated credit                                                  | Q2                            |        |         |
| G    | manual card / other refunds executed in the period (count / amount) | Q5                            |        |         |
| H    | settled-card refunds needing the §5 procedure                       | accountant                    |        |         |

## 8. Sign-off form (**BLANK — not completed by the engineering team**)

| Criterion (see `PHASE-3B-CLOSURE-EVIDENCE.md` §4.2)              | Accepted / accepted with procedure / rejected | Condition / note |
| ---------------------------------------------------------------- | --------------------------------------------- | ---------------- |
| S1 accounts and convention                                       |                                               |                  |
| S2 journals J1–J4 on the three samples                           |                                               |                  |
| S3 pending-refund presentation: **P1** / **P2**                  |                                               |                  |
| S4 manual card / other, **including the settled-card case (§5)** |                                               |                  |
| S5 VAT treatment                                                 |                                               |                  |
| S6 period-end procedure (§6)                                     |                                               |                  |
| S7 Q3 = 0 and summary reconciled at each close                   |                                               |                  |
| S8 reporting decision R-1                                        |                                               |                  |
| S9 segregation of duties                                         |                                               |                  |
| S10 cash-drawer procedure until Phase 4                          |                                               |                  |
| S11 posting-date policy                                          |                                               |                  |
| S12 F-4 controls and their stated residual                       |                                               |                  |
| S13 sample run on realistic data                                 |                                               |                  |

Accountant: ______________ Role: ______________ Date: ______________ Signature: ______________
