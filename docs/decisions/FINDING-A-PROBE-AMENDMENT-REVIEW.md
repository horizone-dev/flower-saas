# FROZEN FINANCIAL AMENDMENT — REVIEW ONLY — DO NOT MERGE

**Finding A — two journal-existence probes in the frozen Sales and Tender report statements.**

|                       |                                                                                                                                                                                                                                                                                                             |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status                | **CANDIDATE. Not approved. Not merged. Not activated.** The owner authorised this draft PR for independent review only.                                                                                                                                                                                     |
| Approvals recorded    | **None.** No independent security reviewer and no accountant is named; nothing here is an approval by anyone.                                                                                                                                                                                               |
| Open findings         | **F-1 — the Tender rewrite reads the whole receipt history when the unproven remainder is non-empty. F-2 — the Sales rewrite reads the whole invoice-journal ledger for any company window (section 7). Both must be resolved or consciously accepted by the owner before this amendment can be approved.** |
| Base                  | `origin/main` `ea56cff` (Phase 3B frozen). PR #54 and #55 (CI-only candidates) are not touched.                                                                                                                                                                                                             |
| Density guard         | `SALES_REPORT_MAX_DOCUMENTS = 25_000` and the tender movement guard are **not modified**.                                                                                                                                                                                                                   |
| Migrations / postings | None. No schema change, no migration, no journal posting, no permission.                                                                                                                                                                                                                                    |

## 1. Exact file inventory

Commit 1 is the verified candidate patch applied unchanged (`finding-a-probe-rewrite.candidate.patch`, sha256 `d5ca563be090cec8841cec67f36c3c2c83f433c4a4ab99ab35001355094c4d04`; `git diff --binary` of the commit equals it byte for byte).

| Commit | File                                                                                       | Role                                                                       |
| ------ | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| 1      | `apps/api/src/modules/reporting/sales-financial-report.sql.ts`                             | **Frozen statement** — probe `creditNotesWithoutRevenueJournal`            |
| 1      | `apps/api/src/modules/reporting/tender-totals-report.sql.ts`                               | **Frozen statement** — probe `allocatedPaymentsWithoutReceiptJournal`      |
| 1      | `apps/api/src/modules/reporting/task-3b10-checkpoint-b-structural.test.ts`                 | pin amendment — LIMIT counts (sales 3→2, `LIMIT 1) dj` 2→1)                |
| 1      | `apps/api/src/modules/reporting/task-3b10-checkpoint-c-structural.test.ts`                 | pin amendment — sales SHA-256, tender probe text, tender LIMIT count       |
| 1      | `apps/api/src/modules/reporting/task-3b10-checkpoint-d-structural.test.ts`                 | pin amendment — SHA-256 (sales, tender)                                    |
| 1      | `apps/api/src/modules/reporting/task-3b10-checkpoint-e-structural.test.ts`                 | pin amendment — SHA-256 (sales, tender)                                    |
| 1      | `apps/api/src/modules/reporting/task-3b10-checkpoint-f-structural.test.ts`                 | pin amendment — SHA-256 (sales, tender)                                    |
| 1      | `apps/api/src/modules/reporting/sales-financial-report.integration.test.ts`                | +3 behavioural tests (kind predicate, scope predicates, probe equivalence) |
| 1      | `apps/api/src/modules/reporting/tender-totals-report.integration.test.ts`                  | +2 behavioural tests (kind predicate, scope predicate)                     |
| 2      | `apps/api/src/modules/reporting/sales-financial-report.integration.test.ts`                | +2 end-to-end tests (duplicate revenue journals; reversal)                 |
| 3      | `apps/api/src/verification/task-3b10-finding-a-tender-remainder-probe.integration.test.ts` | **new, failing by design** — reproduction of F-1                           |
| 4      | `docs/decisions/FINDING-A-PROBE-AMENDMENT-REVIEW.md`                                       | this document                                                              |

Commit 3 first placed the reproduction in the reporting directory. Three frozen closed-set pins (Checkpoints A, B and C, which enumerate exactly the files allowed in that directory) reject any new file there, and CI run 2 caught it; commit 5 moves the file to `apps/api/src/verification/`, which has no closed-set pin, and the `task-3b10-` file-name prefix (the convention the Checkpoint G verification tests use) exempts it from the "nothing outside the reporting module references Tender Totals" pins. Commit 1 (the amendment itself) adds no file to the reporting directory.

Hashes of the two frozen statements:

| File                            | Before (sha256) | After (sha256)                                                     |
| ------------------------------- | --------------- | ------------------------------------------------------------------ |
| `sales-financial-report.sql.ts` | `de461889…9528` | `268232f81bca039a3c828b4bb8f5beac749b9ae29240926c620a9b8261811f62` |
| `tender-totals-report.sql.ts`   | `c6c5fe43…d374` | `a40c4715d24ffee0a61645a1c269d62d563cf4d61d3784846b8bb36719388aeb` |

## 2. Original and revised SQL semantics

Both probes count rows of an outer set that have **no** sealed journal of the expected kind for the document.

Sales, `creditNotesWithoutRevenueJournal` (outer `fdocs d`):

```sql
-- original
(SELECT COUNT(*) FROM fdocs d
   LEFT JOIN LATERAL (
     SELECT 1 AS "hit" FROM "journal_entry" j3
      WHERE j3."tenantId" = $1::uuid AND j3."companyId" = $2::uuid
        AND j3."sealedAt" IS NOT NULL
        AND j3."sourceKind" IN (${INVOICE_KINDS})
        AND j3."sourceId" = d."invoiceId"::text
      LIMIT 1) rj ON true
  WHERE d."sourceKind" = '${SALES_SOURCE_KINDS.creditNote}' AND rj."hit" IS NULL)

-- revised
(SELECT COUNT(*) FROM fdocs d
  WHERE d."sourceKind" = '${SALES_SOURCE_KINDS.creditNote}'
    AND NOT EXISTS (
     SELECT 1 FROM "journal_entry" j3
      WHERE j3."tenantId" = $1::uuid AND j3."companyId" = $2::uuid
        AND j3."sealedAt" IS NOT NULL
        AND j3."sourceKind" IN (${INVOICE_KINDS})
        AND j3."sourceId" = d."invoiceId"::text))
```

Tender, `allocatedPaymentsWithoutReceiptJournal` (outer `alu u`, the unproven remainder) is the same rewrite with `j3` → `j`, `sourceKind = customerReceipt` and key `u."paymentId"::text`.

Why the two forms return the same set of rows:

- **Predicates are copied unchanged**: tenant, company, `sealedAt IS NOT NULL`, source kind(s), source id. Scope (tenant and company) is therefore identical, and RLS still applies to the inner read.
- **`LIMIT 1` adds nothing to an existence test.** The lateral form keeps an outer row exactly when the inner query returns zero rows; `NOT EXISTS` keeps it exactly when no inner row qualifies.
- **NULL key**: `sourceId = NULL` is never true, so the inner set is empty and the outer row is kept by both forms. In production data the sales key is not null (`credit_note.invoiceId` is `NOT NULL`) and payment ids are not null; the equivalence test below covers a NULL key explicitly.
- **Duplicates**: two matching journals still make the inner set non-empty; neither form counts the row (the duplicate-revenue probe, unchanged, reports that case).
- **Nothing else moves**: no money, VAT, rounding, grouping, ordering or JSON-shape expression is touched, and neither is the duplicate-revenue probe (`LIMIT 1 … dj`).

What does change is the plan. On PostgreSQL 17.12 the lateral form is costed as a per-outer-row `Seq Scan` of `journal_entry`; the inflated estimate also pushes the statement over the JIT threshold, which is the dense-window failure (Finding B). `NOT EXISTS` plans as `Hash Join (Right Anti)` on 17.11 and 17.12. **Section 7 explains why that plan is also the source of F-1 and F-2.**

## 3. Before and after performance (single machine, EXPLAIN ANALYZE ms, one run per cell)

PostgreSQL 17.12 image digest `0d938e97…f6ac`; 17.11 digest `ff871389…3b4f`. 1× = 12,000 invoices over 1,095 days; 3× = 36,000 over 3,285 days (the same number of documents per window at both sizes). Separate immutable trees for shipped and candidate; manifests verified unchanged after each run.

| Window (documents)    | shipped 1× 17.12 | candidate 1× 17.12 | shipped 3× 17.12 | candidate 3× 17.12 | shipped 3× 17.11 | candidate 3× 17.11 |
| --------------------- | ---------------- | ------------------ | ---------------- | ------------------ | ---------------- | ------------------ |
| 7 days (86)           | 43               | 24                 | 110              | 83                 | 35               | 55                 |
| 1 day (13)            | 13               | 14                 | 43               | 53                 | 20               | 36                 |
| 30 days (369)         | 98               | 40                 | 233              | 125                | 101              | 81                 |
| **90 days (1,105)**   | **416**          | **133**            | **1,155**        | **185**            | 132              | 150                |
| 365 days (4,480)      | 1,481            | 339                | 5,925            | 559                | 427              | 459                |
| full history (13,439) | 4,901            | 1,074              | over cap         | over cap           | —                | —                  |
| branch, 90 days (246) | 40               | 39                 | 62               | 66                 | 68               | 54                 |
| branch, full (3,000)  | 427              | 440                | 1,289            | 1,185              | 940              | 934                |

Root plan cost, 90 days, 3×: shipped 17.12 135,878; candidate 17.12 30,929; shipped 17.11 27,406. The shipped probe on 17.12 is a `Seq Scan` with 99 loops (11,499 → 35,499 rows removed per loop, 3.0 → 9.1 ms per loop).

Reading it without extrapolation: shipped on 17.12 grows about ×2.8 for a ×3 ledger; the candidate grows about ×1.4 (90 days) and ×1.6 (365 days) — sub-linear, **not** demonstrably constant (two ledger sizes, one run each, noise not measured). At 3× on 17.12 the candidate is 1.2–1.4× the 17.11 numbers on the 90-day and 365-day windows. Individual short windows are slower for the candidate on 17.11 (for example 1 day: 20 → 36 ms); the table does not claim a universal speed-up.

Suite results, PostgreSQL 17.12 at 1×: candidate `sales-financial-report.query-plan` 9/9, shipped 6/9 (the seq-scan assertion). At 3× the candidate passes 8/9; the one failure is the `full history` test, which returns `invoiceCount: 0` because that window holds 36,000 documents, over the 25,000-document guard — **the same assertion fails identically for the shipped SQL on 17.11 and 17.12 and for the candidate on 17.11**. It is a scale assumption in that test, not a candidate defect, and not a financial difference.

## 4. Output comparison: 54 of 54 identical, and what that does not prove

The raw `report` JSON text of the shipped statement and the candidate statement was compared byte for byte, same session, same dataset, on PostgreSQL 17.12:

| Suite            | 1×  | 3×  | Total                       |
| ---------------- | --- | --- | --------------------------- |
| Sales statement  | 8   | 8   | 16                          |
| Tender statement | 19  | 19  | 38                          |
| **Total**        |     |     | **54 of 54 byte-identical** |

Company and branch scopes are included, as is the over-cap sales window (both return the same empty aggregate). The tender query-plan suite also passes 18/18 at 3× on 17.12.

**Coverage limits — what the 54 comparisons do not show:**

1. The generated datasets are internally consistent, so every integrity-probe counter is 0 in all 54 comparisons. They prove the happy path and the plan, **not** anomaly detection.
2. In the tender generator every allocation journal has the same date as its receipt journal, so the unproven remainder is **empty**. The 54 comparisons therefore never exercise the probe that F-1 is about.
3. One dataset generator, two sizes, one run each; amounts are in one currency; no multi-tenant noise beyond the unit tests.
4. Equivalence of the probe _predicate_ is proved separately by the behavioural tests in section 5, not by the comparisons.

## 5. Behavioural and mutation evidence

Behavioural results, PostgreSQL 17.12 and 17.11: sales integration 70/70, tender integration 107/107 on both versions; structural suites 406/406; sales dense-window 9/9 and tender dense-window 11/11 on 17.12 (candidate); whole reporting directory 28 files, 971 passed, 2 skipped (both skips pre-date this work: `it.skipIf(… !== 100_000)` in the receivables and customer-liabilities density tests). No test was removed, skipped or loosened; no threshold changed.

Tests added with the amendment (all pass on both the shipped and the candidate SQL unless stated):

| Test                        | Protects                                                                                                                                     |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| sales: kind predicate       | relabelling the invoice journal to `payment_allocation` must make the credit note "lack" a revenue journal                                   |
| sales: scope predicates     | a decoy revenue journal in a sibling company or another tenant must not satisfy the probe                                                    |
| sales: `PROBE EQUIVALENCE`  | SQL-level legacy vs candidate over a VALUES list with NULL, duplicate, wrong kind, other company, other tenant, unsealed — both count 6 of 8 |
| tender: kind predicate      | a non-receipt journal on the payment id must not satisfy the probe                                                                           |
| tender: scope predicate     | a receipt journal in another company must not satisfy the probe                                                                              |
| sales: end-to-end duplicate | invoice with both revenue journals is `duplicateRevenueJournals`, never "missing" (commit 2)                                                 |
| sales: end-to-end reversal  | fully reversing the invoice journal does not remove the original sealed journal as proof (commit 2)                                          |
| tender: remainder probe     | **fails on the candidate by design — F-1 (commit 3)**                                                                                        |

Mutants of the new probe — sales M1–M7, tender T1–T4: all caught. Before this work the mutants that dropped the kind or company predicate survived the behavioural suites (for the shipped query too); the added tests close that gap. Two limits: the sales tenant-predicate mutant is behaviourally equivalent under RLS (a decoy in another tenant is invisible to the RLS role) and is held only by the structural text pin; and **no mutant or test could have caught F-1**, because F-1 is a plan shape, not a result.

Refunds and credit-note VAT are covered by the existing suites (titles mention refunds 1/26 sales/tender, credit notes 9/3, VAT 2/4, KWD three-decimal 1/2); the amendment does not change any amount, so these are regression coverage, not new proof. **No existing test title mentions "reversal"**; the end-to-end reversal test in commit 2 is the first.

## 6. Where the evidence ends

Sections 3–5 show the candidate fixes the 17.12 regression and changes no output on the measured data. Section 7 shows what that measured data could not show: both rewritten probes become a hash anti-join, and a hash anti-join reads the whole matching journal history. Read sections 3–5 as "better than the shipped statement on 17.12", **not** as "as good as the shipped statement on 17.11".

## 7. Open findings against the candidate

### 7.1 F-1 — Tender probe reads the whole receipt history when the remainder is non-empty

The tender statement proves "an allocated Payment has a receipt journal" from the in-period journals first; only the **unproven remainder** (a Payment allocated in the window whose receipt journal was posted in an earlier period) is probed against the unique source index. The frozen SQL header records that a per-Payment existence probe over every Payment was rejected because "a hash anti-join read the whole receipt history for a one-day report". The candidate's `NOT EXISTS` is accepted by the rewritten pin only because the keyword is followed by a newline; its plan is exactly that rejected shape once the remainder is non-empty.

`task-3b10-finding-a-tender-remainder-probe.integration.test.ts` (commit 3): 60,000 receipt journals of history, one day holding 40 allocation journals whose receipts are 40+ days old, and a second company whose 5 allocated Payments have no receipt journal at all.

| PostgreSQL | statement              | positive company: journal rows read | negative company: journal rows read | anomaly counter (positive / negative) | test          |
| ---------- | ---------------------- | ----------------------------------- | ----------------------------------- | ------------------------------------- | ------------- |
| 17.12      | shipped (LATERAL)      | 80                                  | 5                                   | 0 / 5                                 | passes 2/2    |
| 17.12      | candidate (NOT EXISTS) | 60,040                              | 60,000                              | 0 / 5                                 | **fails 2/2** |
| 17.11      | shipped (LATERAL)      | 80 (40 source-index probes)         | 5                                   | 0 / 5                                 | passes 2/2    |
| 17.11      | candidate (NOT EXISTS) | 60,040                              | 60,000                              | 0 / 5                                 | **fails 2/2** |

The counters are identical, so this is a bounded-read regression, **not** a financial difference. The assertions are the shipped bounds (journal rows read ≤ 3·K + 500 and source-index probes ≤ K + 5 when no parallel workers). On the machine this ran in 25–33 ms for 60,000 journals; the point is how the cost scales, not that it is slow today.

### 7.2 What the existing suites could not see

In the generators of the tender query-plan, dense-window and sales query-plan suites every allocation journal carries the same date as its receipt journal, so the remainder is empty and the probe has nothing to do. All 54 byte comparisons, the 18/18 tender plan results and the 11/11 dense-window results are therefore silent on F-1.

### 7.3 F-2 — the Sales candidate reads the whole invoice-journal ledger for any window

Same mechanism, measured on the sales statement. `journalRowsRead` = sum of rows × loops over every `journal_entry` node of the statement's plan (one EXPLAIN per scenario; shipped = PostgreSQL 17.11, i.e. the plan before the 17.12 regression; candidate = 17.12).

| Window (documents)    | shipped 17.11, 1× ledger | shipped 17.11, 3× ledger | candidate 17.12, 1× ledger | candidate 17.12, 3× ledger |
| --------------------- | ------------------------ | ------------------------ | -------------------------- | -------------------------- |
| 1 day (13)            | 15                       | 15                       | 12,013                     | 36,013                     |
| 7 days (86)           | 94                       | 94                       | 12,086                     | 36,086                     |
| 30 days (369)         | 402                      | 402                      | 12,369                     | 36,369                     |
| 90 days (1,105)       | 1,204                    | 1,204                    | 13,105                     | 37,105                     |
| 365 days (4,480)      | 4,880                    | 4,880                    | 16,480                     | 40,480                     |
| branch, 90 days (246) | 1,105                    | 1,105                    | 1,105                      | 1,105                      |

The shipped plan on 17.11 reads a number of rows that depends only on the window. The candidate reads the window **plus the company's entire invoice journal history** (the 3× ledger adds exactly 24,000 rows to every company window). Branch-scoped windows are unaffected. Single-run times for the one-day window are 8 → 20 ms (shipped 17.11, 1× → 3×) and 19 → 41 ms (candidate); the ledgers are small, so today's cost is small, but it grows with history while the shipped plan's does not.

### 7.4 What this means for the amendment

| Statement | PostgreSQL 17.11                      | PostgreSQL 17.12                                                  |
| --------- | ------------------------------------- | ----------------------------------------------------------------- |
| shipped   | bounded by the window (good)          | per-row `Seq Scan`, growth ≈ window × ledger, JIT trips (the bug) |
| candidate | O(ledger) probes (worse than shipped) | O(ledger) probes (much better than shipped)                       |

The candidate removes the 17.12 pathology by moving both probes to a linear-in-ledger shape. That is a trade, not a restoration. The pins that protect the original design intent (tender header; "journal rows read ≤ 3·windowJournals + 500; source-index probes ≤ ceil(windowJournals/10) + 5") were weakened or bypassed by the pin amendments, and no suite detects the difference.

### 7.5 Options (owner decision; none implemented)

1. **Defer.** Keep the staging and test database pinned to PostgreSQL 17.11 (#51 for tests; the staging pin amendment is prepared, not applied). The frozen statements are unchanged and bounded. This is the lowest-risk path for the December internal alpha and costs only the discipline of not floating the tag.
2. **Accept the candidate** with F-1 and F-2 recorded as a conscious trade (linear-in-ledger probes, small today). Requires the owner, the accountant and the security reviewer to accept section 7.4 explicitly, and the pin text to be rewritten honestly.
3. **A bounded variant.** The aim is the original design — one index probe per outer row — without 17.12's `Seq Scan`. One variant was tried on the tender probe: `WHERE (SELECT 1 … LIMIT 1) IS NULL` (a scalar subquery). It restores the bounded read (80 rows on 17.11 and 17.12, remainder test 2/2 on both) **but fails two frozen dense-window gates, reproducibly, on 17.12 (two runs, one of them on an otherwise idle machine)**: "ABOVE the limit … materially cheaper than the accepted report" measured 4,898 ms against a required < 3,552.5 ms, and "EXPLAIN at 100,001 … a fraction of the accepted plan" measured 4,849 ms against < 3,797.5 ms; the candidate passes 11/11 on the same machine. So it is not a drop-in and is **not** offered here. Not tried: the sales probe in this form, restructuring so the in-window document ids are materialised before probing, or a per-kind `UNION ALL` of index probes. Each needs the same suites, the 54 comparisons and the mutants re-run.

## 8. What approving this amendment would change (frozen-contract requirements)

The two `.sql.ts` files and the structural pins are **frozen contract** (Phase 3B, Task 3b.10). Merging this would amend that contract. Required, in this order, none of which has happened:

1. **Owner decision on F-1 and F-2** (section 7.5): defer on 17.11, accept the linear-in-ledger probes, or require a verified bounded variant.
2. **Accountant** confirms that no posted amount, tax figure, rounding rule or report category changes, and that byte-identical report JSON on the measured datasets (section 4, with its limits) is sufficient to leave the contract unchanged in substance.
3. **Independent security reviewer** confirms the predicates inside each `NOT EXISTS` equal the removed lateral predicates, including tenant and company scoping and `sealedAt IS NOT NULL`.
4. The pin amendments in commit 1 are accepted as a set: SHA-256 pins (sales ×4, tender ×3), LIMIT-count pins (sales 3→2 and `LIMIT 1) dj` 2→1; tender 2→1) and the tender per-row-probe pin text. The tender pin's regex passes only because the keyword is followed by a newline; its comment was rewritten to state what is now allowed. **A reviewer should decide whether that pin should instead forbid a hash anti-join over the receipt history (which F-1 shows the candidate performs).**
5. A decision-log entry recording the amendment, the approvers and the test-image policy (PR #51 pins the test database to 17.11 for reproducibility only; production on 17.12 is a separate decision).

## 9. Risks

| #   | Risk                                                                                                                                                                                                            | State                                                              |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| F-1 | Tender candidate reads the whole receipt history when the unproven remainder is non-empty (shipped: bounded). Counts identical; cost grows with history.                                                        | **Open, reproduced (commit 3)**                                    |
| F-2 | The sales candidate is also a hash anti-join: it reads the company's whole invoice-journal history for any company window (1-day window: 12,013 rows at 1× ledger, 36,013 at 3×; shipped on 17.11: 15 at both). | **Open, measured (section 7.3); not covered by a committed test**  |
| R-1 | Timings are single runs on one laptop; the candidate's growth is sub-linear, not shown constant.                                                                                                                | Accepted limit of the evidence                                     |
| R-2 | The 54 comparisons run on consistent data; anomaly detection rests on the behavioural and mutation tests.                                                                                                       | Accepted limit of the evidence                                     |
| R-3 | The sales tenant-predicate mutant is caught only by the structural text pin (RLS makes it behaviourally invisible).                                                                                             | Accepted                                                           |
| R-4 | Production database minor version is a floating `postgres:17` in staging. Until the amendment is approved, only the version pin protects report latency.                                                        | Separate amendment prepared (staging pin patch), **not applied**   |
| R-5 | `planner` behaviour is version-specific; a future minor release can change either form.                                                                                                                         | Mitigated only by pinning + the dense-window and query-plan suites |

## 10. Reviewer checklist (independent security reviewer and accountant; neither is named)

1. The diff of the two `.sql.ts` files is exactly the two probe rewrites (commit 1 hunks) — nothing else.
2. Predicates inside each `NOT EXISTS` equal the removed lateral predicates (tenant, company, `sealedAt IS NOT NULL`, kind, key).
3. `NOT EXISTS` vs `LEFT JOIN LATERAL … LIMIT 1 … IS NULL` for NULL keys and duplicate matches (test `PROBE EQUIVALENCE`).
4. Decide the tender structural pin question (section 8, item 4) in light of F-1.
5. Reproduce F-1 (`task-3b10-finding-a-tender-remainder-probe.integration.test.ts` fails on the candidate, passes on the shipped statement) and F-2 (section 11), and decide.
6. Accountant: no amount, tax figure, rounding or category changes; the limits in section 4 are acceptable.
7. Re-run on a clean checkout on both `postgres:17.11` and `postgres:17.12` (sales/tender integration, query-plan, dense-window, structural).
8. Decide whether the 3× `full history` scenario needs a cap-aware assertion (the existing test is not changed here).
9. Owner: the frozen-contract amendment, the staging PostgreSQL pin and any merge are three separate decisions.

## 11. Reproduction

```bash
# the verified candidate patch applied to ea56cff == commit 1
git diff --binary ea56cff..<commit-1> | sha256sum        # d5ca563b…4d04

# every changed suite (needs Docker; one heavy run at a time)
pnpm --filter=@flower/api exec vitest run src/modules/reporting/task-3b10-checkpoint-b-structural.test.ts \
  src/modules/reporting/task-3b10-checkpoint-c-structural.test.ts src/modules/reporting/task-3b10-checkpoint-d-structural.test.ts \
  src/modules/reporting/task-3b10-checkpoint-e-structural.test.ts src/modules/reporting/task-3b10-checkpoint-f-structural.test.ts
pnpm --filter=@flower/api exec vitest run src/modules/reporting/sales-financial-report.integration.test.ts \
  src/modules/reporting/tender-totals-report.integration.test.ts
# F-1 reproduction (fails on the candidate, passes on the shipped statement)
pnpm --filter=@flower/api exec vitest run src/verification/task-3b10-finding-a-tender-remainder-probe.integration.test.ts
```

F-2 was measured with a local, **uncommitted** copy of `sales-financial-report.query-plan.integration.test.ts` that logs, per scenario, the rows read from `journal_entry`; the helper is:

```ts
const journalRowsRead = nodes
  .filter((n) => n['Relation Name'] === 'journal_entry')
  .reduce((s, n) => s + (n['Actual Rows'] ?? 0) * (n['Actual Loops'] ?? 1), 0);
```

Run it against the shipped statement on `postgres:17.11` and the candidate on 17.12 at `SALES_VOLUME_INVOICES=12000 SALES_DAYS=1095` and `36000` / `3285`.

Plan metrics: `SALES_PLAN_METRICS_FILE` / `TENDER_PLAN_METRICS_FILE`; dataset size: `SALES_VOLUME_INVOICES` / `SALES_DAYS`, `TENDER_VOLUME_EVENTS` / `TENDER_DAYS`.
