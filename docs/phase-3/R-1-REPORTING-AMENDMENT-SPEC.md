# R-1 — exact amendment of the FROZEN Sales and Tender Totals reports (**FOR OWNER APPROVAL — NOT APPLIED**)

- **Status: R-1.1 TRIAL-VERIFIED then reverted (§3.6); R-1.2 recommendation only. NOT applied.** Every frozen report file is byte-identical to `HEAD`.
  This document is the portion of the reporting correction that exceeds the already-approved RB-1 scope and therefore **stops here for the owner's decision**.
- **What IS implemented and verified (within RB-1 scope, no frozen file touched):** the read-only **anonymous credit-note summary**
  (`GET /v1/companies/:companyId/anonymous-credit-note-summary` and the branch route) — a complete, ledger-reconciled account of the two new journal
  kinds, plus the **adjustments to subtract** from the frozen reports. With it, `frozen − adjustments = general ledger` for net sales, output tax
  and cash, to the minor unit (measured; see the evidence document §A). **This amendment is only about folding that into the frozen reports'
  own responses.**
- Basis: derived from reading the frozen files and their pins on 2026-11-12. The implementing task must re-verify every statement against the
  pins before editing, because the pins — not this text — are the contract.

## 1. Why a frozen-contract amendment (and not "just a code change")

| Frozen contract                                                                                                                                                                                  | Where it is frozen                                                            | Consequence for anonymous credits                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| "The Sales report selects **ONLY** the four frozen source kinds — no other kind, no registry, no catch-all" (owner ruling **3b.10-SR**)                                                          | pin B (`the report selects ONLY those four kinds`), decision-log row 3b.10-SR | a fifth kind (`anonymous_credit_note`) is outside the ruling                                                      |
| "Reconciliation covers ONLY the included source kinds (never every journal that hits a revenue account)"                                                                                         | pin B                                                                         | the ledger control stays per-kind; a whole-account tie-out would reverse the ruling (**not proposed**)            |
| "Refund, payment, advance, settlement and catalogue tables are NEVER read" by Sales                                                                                                              | pin B                                                                         | the anonymous refund table cannot be read by Sales (not needed: Sales needs the note, not the refund)             |
| The Tender statement reads **exactly** its tables and **exactly** four journal kinds; a movement is a recorded `Payment` or an actual `Refund`                                                   | pin C; owner ruling **TT-1** / **3b.10-TD**                                   | an executed anonymous refund is neither a `Refund` row nor one of the four kinds                                  |
| "A pending or failed refund creates NO refund journal and NO `Refund` row — the exact source kinds can never see it"                                                                             | `tender-totals-report.sql.ts` header, pin C                                   | showing issued / pending / failed anonymous refunds needs a NEW, explicitly additive block (a new table read)     |
| The Tender period authority is the **sealed journal's `postingDate`, and only that**                                                                                                             | pin C                                                                         | a manual card / other refund posts **no journal** (by the approved two-phase design), so it has no authority date |
| The Sales and Tender production files are **hash-frozen byte for byte** (pins C, D, E, F hold the SHA-256 of `sales-financial-report.ts`, `sales-report-range.ts`, `tender-totals-report.ts`, …) | `task-3b10-checkpoint-{c,d,e,f}-structural.test.ts`                           | any edit changes a frozen hash in up to four pins                                                                 |

## 2. Options (decision R-1)

| Option                                                                                                              | What changes                                                                                                                         | Risk / cost                                                                                                                                                                                                         | Recommendation                                   |
| ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| **R-1.0 — keep both frozen reports unchanged; the summary is the authoritative anonymous report** (**implemented**) | nothing frozen; the summary (verified) carries the adjustments and its own ledger reconciliation; consumers subtract the adjustments | two calls to see net sales; a reader of the frozen Sales report alone still sees the legacy figure (and "reconciled" for the kinds it knows) — **mitigated by the summary's `notice` and the documented procedure** | **safest default for the pilot**                 |
| **R-1.1 — amend Sales only** (additive block + one more source kind)                                                | §3 below                                                                                                                             | moderate: one SQL statement, one response type, 4 hash constants, pin B literals, the 25 000-document gate re-run                                                                                                   | **recommended next step after the pilot starts** |
| **R-1.2 — amend Sales and Tender**                                                                                  | §3 + §4 below                                                                                                                        | **high**: new journal shape in the Tender controls, a non-journal authority for manual card / other (owner ruling), the 100 000-movement density gate and its JIT-cost lesson re-measured                           | not recommended until R-1.1 is proven            |

## 3. R-1.1 — the exact Sales amendment (additive; legacy fields and their values unchanged)

**3.1 Statement (`sales-financial-report.sql.ts`).** The statement stays ONE statement over the same CTE chain; the changes are:

1. `SALES_SOURCE_KINDS` gains `anonymousCreditNote: 'anonymous_credit_note'` (literal copied from the producer constant
   `ANONYMOUS_CREDIT_NOTE_SOURCE_KIND`, never retyped — the existing pin style).
2. `sel` (sealed journals of the period): the `IN (…)` list gains the kind.
3. `cand` (density candidates, `LIMIT 25001`): one more arm for the kind — **anonymous credit notes count as financial documents** toward the
   25 000-document limit (the limit's meaning is unchanged).
4. `docs`: a primary-key join `anonymous_credit_note n ON n.id = s."sourceId"::uuid` (guarded by the existing UUID regex), explicit tenant +
   company predicates, supplying `branchId`, `total`, `tax`. It reads **no refund table** (so the "refund tables are never read" pin still holds).
5. `br` (per-branch aggregates): three more `FILTER` aggregates: `anonymousCreditNoteCount`, `anonymousCreditNoteTotal`, `anonymousCreditNoteTax`.
6. `gl`: the new kind's journal lines join the existing per-branch / kind / account grouping (so the control below can compare).
7. `ic` (integrity counters): `anonymousCreditNotesWithoutRevenueJournal` (a note whose sealed journal is absent) — fails closed like the existing ones.

**3.2 Response (`sales-financial-report.ts`) — new fields only; no existing field changes name, type or value.**

```jsonc
"anonymousCreditNotes": {                       // NEW — credits of anonymous (walk-in) invoiced sales; separate from `creditNotes`
  "anonymousCreditNoteCount": 3,
  "anonymousCreditNoteNetExTaxMinor": "…",      // Σ (total − tax)  — the net-of-discount convention (3b.9-ACC)
  "anonymousCreditNoteTaxMinor": "…",
  "anonymousCreditNoteTotalMinor": "…"
},
"netSalesAfterAllCredits": {                    // NEW — invoices − credit notes − anonymous credit notes
  "netSalesAfterAllCreditsExTaxMinor": "…", "netSalesAfterAllCreditsTaxMinor": "…", "netSalesAfterAllCreditsTotalMinor": "…"
},
"reconciliation": {                              // existing keys untouched; ONE new sibling, and `reconciled` becomes the AND
  "reconciled": true,
  "anonymousCreditNotes": { "revenueReversal": {…Check}, "outputTaxReversal": {…Check} }   // NEW
}
```

`creditNotes` and `netSalesAfterCreditNotes` keep their exact historical meaning and values (**customer-linked credit notes only**) — a consumer
built before this amendment sees the same numbers it always saw. A report for a period with **no** anonymous credit note returns zeros in the new
fields and an unchanged `reconciled`. The existing label rules hold: no "profit", no gross-plus-contra presentation, no float.

**3.3 Reconciliation rule (honest limit).** The new check is per source kind, exactly like the existing ones (revenue reversal = Σ(total − tax) vs the
journal's `REVENUE.SALES` debit; output-tax reversal likewise). **It is not a whole-account tie-out** — pin B forbids "every journal that hits a
revenue account" by owner ruling. The whole-ledger statement remains the Trial Balance's; the summary's `reconciliation` and the evidence table already
tie the report figures to it.

**3.4 Pins to amend (each is a deliberate, reviewed edit; every other expected value stays).**

| Pin                                                   | Edit                                                                                                                                                   |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| B — "the four source kinds are exactly the literals…" | five kinds; the new literal imported from its producer                                                                                                 |
| B — "the report selects ONLY those four kinds"        | five                                                                                                                                                   |
| B — "reads exactly the document tables…"              | + `anonymous_credit_note` (still no refund / payment / advance / settlement table)                                                                     |
| B — "reconciliation covers ONLY the included kinds"   | + the fifth kind                                                                                                                                       |
| C, D, E, F — frozen-file SHA-256 constants            | new hashes for every Sales file edited (`sales-financial-report.sql.ts`, `sales-financial-report.ts`, and `…repository.ts` if its JSON parser changes) |
| the decision log                                      | row **3b.10-SR** amended in place with a dated, owner-signed line (the pins test that it appears exactly once)                                         |
| `phase3b-authorized-additions` closed set             | the pinned statement that "the frozen reporting files are not edited by this feature" is replaced by the reviewed amendment                            |

**3.5 Verification gate (must be green before the amendment is accepted).** The existing Sales unit, integration, **dense-window (25 000 documents,
< 10 s local gate, 25 001 short-circuit)** and **query-plan (EXPLAIN ANALYZE, BUFFERS)** suites; the new before / after tests already written for the
summary (they transfer: `frozen − adjustments = ledger` becomes `netSalesAfterAllCredits = ledger`); a regression that a company with no
anonymous credit note returns a byte-identical legacy section; company / branch isolation; the 90-day cap; and the full regression.

### 3.6 TRIAL VERIFICATION OF R-1.1 (executed 2026-11-12; **the amendment was then reverted — the closure tree is unchanged**)

R-1.1 was applied **in place** on the closure tree with byte-exact backups, tested, saved as a patch, and **restored byte-for-byte** (verified by hash; the 32
frozen reporting production files are identical to `HEAD`). Artifacts, ready to apply on approval: **`amendments/R-1.1/R-1.1-sales-report.patch`** (9 files),
**`r11-demonstration.integration.test.ts.txt`** and **`measured-outputs.txt`**.

**What the patch changes:** the Sales SQL (the fifth kind imported from its producer, one more `LEFT JOIN` and the `COALESCE` arms, three `FILTER` aggregates, three JSON
fields), the pure builder (aggregate fields, two new controls, the additive `anonymousCreditNotes` and `netSalesAfterAllCredits` blocks and the new
`reconciliation.anonymousCreditNotes` sibling), the repository parser (three fields), one unit-test helper, **12 byte-hash constants** (pins C, D, E, F × 3
Sales files) and **7 pin-B assertions** (the kind list, the selection regex, the table list, the branch predicate, the control list, the density-stage anchor, the
counted kinds) — **19 amended assertions, found by running the pins, not guessed.**

**The requested demonstration — a fully reversed anonymous sale cannot be returned as reconciled without its credit adjustment** (real PostgreSQL, full HTTP stack,
same test file run in two modes; sale 6 999 = 6 666 + VAT 333, fully credited and the cash refund attested):

| Scenario                                                                               | TODAY (frozen report)                                            | WITH R-1.1                                                                                                            |
| -------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| the fully reversed sale                                                                | `200`, **`reconciled: true`**, net sales **6 666**, ledger **0** | `200`, `reconciled: true`, `anonymousCreditNotes` 6 999 / 333, **`netSalesAfterAllCredits` = 0 / 0 / 0 = the ledger** |
| the credit note's stored tax is changed by 1 (a document disagreeing with its journal) | `200`, `reconciled: true` — **silent**                           | **`500 REPORT_SALES_GL_MISMATCH` — no figures returned**                                                              |
| a **phantom** anonymous credit journal (no document behind it)                         | `200` — **silent**                                               | **`500 REPORT_SALES_SOURCE_INTEGRITY` — no figures returned**                                                         |
| an unaffected branch while another is corrupted                                        | `200`                                                            | `200` (isolation holds)                                                                                               |

At unit level: with the sale and its reversal journals in the ledger, **omitting the credit note from the source side makes the report refuse** (`REPORT_SALES_GL_MISMATCH`);
including it reconciles and nets to exactly zero.

**Gates run against the amended tree:** the Sales unit suite (28 tests, 6 new), the six frozen 3b.10 pins (392 tests together with the unit file), and the **whole
reporting group — 28 files, 966 passed, 2 skipped — including the Sales integration, the 25 000-document dense-window gate, the query-plan (EXPLAIN) gate and the
HTTP wiring**. **Mutation:** 8 mutants of the amendment (kind dropped from the selection, wrong kind in the count, each control unenforced, the net ignoring the
credit, a wrong side, a wrong parse field, the tax not read) — **8 / 8 caught** (one initially survived because the demonstration did not assert the count; it now does).

**What this trial does NOT prove:** it is a local run. It does not replace CI, an independent review, or a re-measurement of the 25 000-document gate on staging
hardware, and it changes owner rulings (3b.10-SR) that **only the owner can amend**. The decision-log row and the exact owner approval are in §5.

## 4. R-1.2 — what the Tender amendment would additionally require (**owner rulings needed first**)

The Tender report is **journal-anchored** (period = the sealed journal's `postingDate`; a movement = a recorded `Payment` or an actual `Refund`).
Anonymous refunds break three of its premises, so they cannot be "just added":

1. **A different journal shape.** The Tender refund controls expect `Dr LIABILITY.CUSTOMER_ADVANCES / Cr <cash|bank|clearing>`. An executed anonymous
   refund is `Dr ASSET.PAYMENT_CLEARING / Cr ASSET.CASH_ON_HAND | ASSET.BANK` (the approved two-phase design). The per-journal shape checks and the
   `refunds` GL controls need a second, explicit shape rule for the new kind.
2. **Manual card / other refunds post no journal.** They have no authority date under the frozen rule. Either they stay out of the frozen report
   (as today — the summary carries them under the company-timezone civil date of the attestation) or the owner rules a **new, non-journal period
   authority** for them. **This is a policy ruling, not an engineering choice.**
3. **Pending and failed lines are not movements.** The frozen report must not show them as refunds. The requirement "distinguish issued, pending,
   executed and failed refunds" is met by a **new additive block** `anonymousRefunds` (never added to `refunds` or `netTenderMovement`), which reads
   the anonymous refund table — a **new table in a statement pinned to "exactly these tables"**.

Further pins and gates: pin C literals (four journal kinds, the table list, the refund-account case), D / E / F hash constants for
`tender-totals-report.{sql,}.ts`, row **3b.10-TT / TD** of the decision log, the **100 000-logical-movement density guard** (an executed anonymous
refund becomes a movement) **re-measured** (the previous implementation had a measured JIT-compilation defect at 100 000 movements; any change to the
statement's cost profile must be re-measured on the dense-window and query-plan suites), and the Tender integration oracle (3 445 lines).

**Recommendation:** do **not** start R-1.2 now. R-1.0 (implemented) already gives the owner the missing figures, ledger-reconciled and with pending /
failed / executed distinguished, without touching an owner-ruled contract. Decide R-1.1 after the pilot; decide R-1.2 only together with the manual-card
authority ruling above.

## 5. What the owner is asked to decide

1. **R-1.0 stays** as the authoritative anonymous report for the pilot (recommended) — _yes / no_.
2. **R-1.1** (Sales only): approve to schedule as a separate, gated task — _now / after the pilot / never_.
3. **R-1.2** (Tender): approve only together with a ruling on the manual card / other refund authority — _defer (recommended) / approve with ruling_.
4. If R-1.1 or R-1.2 is approved: confirm the decision-log rows 3b.10-SR / 3b.10-TT / 3b.10-TD may be amended in place with a dated owner line.

Until the owner answers, **no frozen report file, pin hash or decision-log row is changed.**
