# MVP release plan — controlled release February 2027, expanded launch April 2027

**2026-11-17 · PROPOSAL — NOT APPROVED · no date below is guaranteed.** Built from an audit of the repository and its tests, not from earlier plans. Estimates are engineering estimates ("working days after approvals"), unverified. Nothing here activates a migration, a frozen financial rule, or an unreviewed security surface.

## 1. Audit — what exists, and where it is verified

**Three facts that change the plan**

1. `origin/main` = `ea56cff`: merged through Task 3b.10 reporting, 3b.11 verification and dependency security fixes. **Phase 3B closure (PR #41, 80 files, the anonymous-refund migration) is not merged.**
2. **Everything after that lives in one worktree as 198 uncommitted entries** (148 untracked): **85 frontend files** (Owner Web 53, POS 32), **6 backend modules** (~210 files incl. tests), 4 Phase 4 migrations, the migration runner, staging compose and two CI workflows. On `origin/main`, **Owner Web and POS are login/access skeletons** — the selling, catalog, reports and stock screens exist only in that worktree, never reviewed or built by CI.
3. **Nothing has ever been verified on staging: no staging environment exists on record** (`infra/staging` is untracked; `infra/terraform` is a README). Every test result is local / disposable (Testcontainers) or GitHub CI.

| MVP priority                                  | Class                                                                                             | Evidence (verified in code)                                                                                                                        | Gaps that block use                                                                                                                        |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Super Admin Web                               | **ACTIVE**                                                                                        | committed: tenants, plans, audit, access, sessions pages; platform + secrets APIs (26 routes)                                                      | cannot create staff users                                                                                                                  |
| Owner Web                                     | **INERT** (uncommitted)                                                                           | catalog / pricing / customers / reports / MFA enrolment / step-up / stock-flag pages (53 files)                                                    | no staff creation, orders, receivables, register, receiving, valuation, Setup Wizard                                                       |
| POS sale (cash / card / split, VAT, receipts) | API **ACTIVE**; UI **INERT**                                                                      | `complete-sale`: walk-in `PAY_NOW`, customer `PAY_NOW` / `ON_CREDIT` / advances; GL posted in the sale transaction; POS UI sends `PAY_NOW` only    | unclassified product sells at **0 % VAT** via API (F-6, `tax-arithmetic.ts`); cashier cannot read catalog (F-1); no cashier creation (F-7) |
| Customer credit                               | API **ACTIVE**; UI **none**                                                                       | receivables: credit notes, refunds, advances, opening balances (11 routes)                                                                         | no POS / Owner Web screen                                                                                                                  |
| Inventory receiving, costing, deduction, COGS | **INERT + DRAFT-BLOCKED**                                                                         | `stock` module 87 files, 17 routes, **not registered**; both costing engines; migrations H, I, K, L, M, P, Q, R unapplied                          | C-7, C-8, C-3 (frozen sale hook), C-2 (accounts) unapproved; S-1 review BLOCKED                                                            |
| Build-to-order bouquets                       | **INERT + DRAFT-BLOCKED**                                                                         | recipes (draft M), consumption proved in tests                                                                                                     | D-1a/b/c, C-3; B2 design-only; custom bouquets missing                                                                                     |
| Paid returns / refunds                        | **PARTLY ACTIVE**                                                                                 | invoice credit note + refund merged (3b.8); anonymous refund only in unmerged PR #41; stock return = DRAFT-O + inert service                       | PR-1…PR-8; no POS screen                                                                                                                   |
| Cash register, X / Z                          | **INERT**                                                                                         | register open / read / count / close (5 routes, unregistered, permissions policy-disabled); X-report built, no route; Z storage = unpromoted draft | cash in/out, variance posting, Z promotion await owner + accountant                                                                        |
| GL                                            | **ACTIVE** (sales, credit, refunds, settlements, reports) / **BLOCKED** (inventory, COGS, drawer) | accounting module registered                                                                                                                       | C-2 accounts + nine postings                                                                                                               |
| Customer ordering website                     | **NOT IMPLEMENTED**                                                                               | `customer-web` = 2 source files; no public API                                                                                                     | everything                                                                                                                                 |
| Production readiness                          | **UNVERIFIED**                                                                                    | API **cannot boot** with `NODE_ENV=production` (dev secrets refused, no KMS provider — R-1 patch unapproved)                                       | no staging, no IaC, `HG3b-SALE-LATENCY` open                                                                                               |

**Tested vs verified.** Local: 306 API test files; last full regression 6,058 passed (worktree, 2026-11-16, ≈ 2 h); PR #41 tree 5,895 passed with CI green; browser journeys 4/4 and 17/17 (local, 2026-11-14). **Staging: none.**

## 2. Shortest safe critical path

Three gates that no amount of coding removes, in series; coding runs in parallel behind them:

1. **Get the work into reviewable git** (branches / PRs / CI) — today it is a single uncommitted worktree.
2. **Approvals + independent reviews** — no independent security reviewer and no independent accountant is named (S-1 is BLOCKED for exactly that).
3. **A real staging environment** — nothing can be called verified, load-tested or restorable until it exists.

**Release shape (needs the owner's agreement, §5):**

- **R1 — Controlled pilot (target February):** one company / branch, staff-operated, online-only. Super Admin + Owner Web (catalog, VAT, customers, staff, reports, MFA) + POS (cash / card / split / **on-credit / advance**, VAT fail-closed, receipts, hold / cancel, credit-note refund) + cash register open / close / count + X / Z + existing GL. Stock = **availability flag only**, no COGS, no profit labels (rule 21).
- **R2 — Valued inventory (target late March – April):** receiving, costing, deduction, COGS, B1 bouquets, walk-in paid returns with restock.
- **R3 — Expanded launch (April, at risk):** R1 + R2 stable on staging; customer ordering website (basic) follows (May is realistic).

## 3. P0 blockers (exact)

| #     | Blocker                                                                                                                                                                     | Type                      | Clears when                                                                             |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- | --------------------------------------------------------------------------------------- |
| P0-1  | Work is unreviewed and unmergeable: 198 uncommitted entries                                                                                                                 | process                   | owner authorizes branches / PR slices; Claude prepares the split (no commit until then) |
| P0-2  | PR #41 unmerged (owner O1–O10, accountant A-1…A-4 / RB-1, security S1, staging gate)                                                                                        | approval + migration      | decisions recorded; `20261105…rb1_anonymous_credit_note` applied to a staging copy      |
| P0-3  | API cannot boot in production (R-1)                                                                                                                                         | security                  | R-1 approved and applied                                                                |
| P0-4  | 0 % VAT on unclassified products via API (F-6)                                                                                                                              | frozen-contract amendment | owner approves `F6-vat-server-amendment-FULL.patch`                                     |
| P0-5  | Cannot create cashiers (F-7); cashier sees empty catalog (F-1)                                                                                                              | approval + security       | F-7 route and F-1 approved, security-reviewed                                           |
| P0-6  | No independent security reviewer / no independent accountant named                                                                                                          | governance                | owner names both (S-1, F-7, pilot release review, AL1 / SE1, C-2)                       |
| P0-7  | No staging environment; no IaC; sale latency (`HG3b-SALE-LATENCY`) unmeasured                                                                                               | infrastructure            | owner chooses hosting / region; staging provisioned                                     |
| P0-8  | Cash register / X / Z cannot go live: unregistered, permissions disabled, D / Z1 / E1 (13 approvals), cash in / out and variance posting blocked, AL1 / SE1 (19 + 10 boxes) | approval + migration      | Phase 4 decision package answered; migrations re-stamped (D-ORDER) and promoted         |
| P0-9  | Inventory: C-7, C-8, C-3 (+ I7-1…5), C-2 and the accountant A-items (A-1…A-16), PR-1…8, D-1a/b/c                                                                            | approval + migration      | recorded; H, I, K, L (+ M, O) applied on a staging copy in order                        |
| P0-10 | Migration order conflict (Phase 4 vs Inventory)                                                                                                                             | migration                 | owner decides D-ORDER                                                                   |

**Migration order to enforce:** PR #41 → Phase 4 (4 migrations) → D / Z1 / E1 → AL1 → SE1 → Inventory H … R; each applied first to a staging copy with RLS / cross-tenant probes and the schema-drift gate.

## 4. Week-by-week sequence (W0 = this week; assumes decisions land as marked — each slip moves everything after it)

| Week                       | Human gate (owner / reviewer)                                                                                               | Build (Claude, parallel streams)                                                                                           |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| **W0** Nov 16              | **Decision session 1**: scope (§5), commit / PR authorization, name security reviewer + accountant, hosting, offline stance | prepare the PR-slice plan (no commit); POS customer-credit sale (§10); staging IaC design                                  |
| **W1** Nov 23              | reviewers start F-7 / R-1 / F-6 pack; accountant starts PR #41 + C-2                                                        | land slices on branches (if authorized): Owner Web, POS, infra, CI                                                         |
| **W2** Nov 30              | **Approve batch 1**: R-1, F-6, F-1, F-3, F-7, CI                                                                            | apply each as its own verified change; provision staging                                                                   |
| **W3** Dec 7               | PR #41 decisions; **Phase 4 + D-ORDER decisions**                                                                           | pilot integration on the migrated schema; browser journeys; POS refund screen (existing routes)                            |
| **W4–W5** Dec 14–25        | security review of batch 1; owner reviews                                                                                   | cash register: re-stamp + promote migrations, register routes + permissions, X / Z, POS register screens, E-5              |
| **W6** Dec 28              | holiday buffer                                                                                                              | staging deploy 1, backup / restore drill, `HG3b` latency run                                                               |
| **W7–W8** Jan 4–15         | pilot security review closed; accountant checks real staging numbers                                                        | Owner Web gaps, receipts, training material, fixes from review                                                             |
| **W9** Jan 18              | owner UAT in the shop; **go / no-go**                                                                                       | release candidate, freeze                                                                                                  |
| **W10–W11** Jan 25 – Feb 1 | pilot cut-over decision                                                                                                     | **R1 earliest go-live window opens**                                                                                       |
| **W12–W14** Feb 8–22       | —                                                                                                                           | **R2 tracks** (parallel since W3 if C-7 / C-8 / C-2 / C-3 approved): H, I, K, L → routes → sale hook → COGS → B1 → returns |
| **W15+** Mar →             | S-1 closure, accountant sign-off, load test                                                                                 | R2 release; customer-web build after its API security design                                                               |

## 5. Deferrals that need explicit owner agreement

On 2026-11-15 the owner rejected an availability-only pilot. R1 above **re-opens that** and so needs a **written** decision; without it the honest date for the inventory-inclusive MVP is April (§7).

| Deferral                                                 | Why                                                   | Estimate                        |
| -------------------------------------------------------- | ----------------------------------------------------- | ------------------------------- |
| Valued inventory, B1, paid returns with restock → R2     | 55–81 working days alone (documented)                 | 44–64 for the recommended slice |
| Customer-linked paid returns (Track C)                   | after R2                                              | 8–12                            |
| Pre-made bouquet production (B2), custom bouquets (D-1c) | design-only / missing                                 | 6–8.5, 3–4                      |
| Customer ordering website                                | not started; public API needs its own security review | ≈ 15–25 (my estimate)           |
| Provider-backed card / gateway payments                  | no vendor chosen (Z-4); vault R-1                     | —                               |
| KSA e-invoicing                                          | gated by Z-8                                          | —                               |
| Supplier bills / payables, landed cost                   | proposal A-9 = no                                     | —                               |
| Offline selling (Class B)                                | see §6                                                | —                               |

## 6. Offline POS — assessed separately

- **Approved decision (Z-6, 2026-09-03): the first release is online-only for financial and inventory-changing sales**; Class B offline cash sale stays architecture-ready behind a tenant flag and needs its own approved model. This plan **keeps Z-6; it does not replace offline-first with online-only — Z-6 already decided it.** If the owner now wants offline selling earlier, that is a **new decision that changes Z-6**.
- **Readiness: shell only.** Service worker precaches the app shell (network-first navigation, API never cached); installable manifest. **No** reference-data cache, **no** queue, **no** IndexedDB, **no** local numbering or reconciliation. The server-side operation-proof protocol (B5.7) exists inert; the Class B conflict / numbering / reservation / idempotency / reconciliation model is **not designed or approved**.
- **Estimate if chosen:** approval of the model 2–3 weeks (human) + ≈ 25–40 working days to build and review (my estimate) → **not February, not April** unless it displaces other scope.
- **Meanwhile:** document network-loss behaviour (banner, sales blocked, no silent loss) and require a connectivity fallback at the pilot shop.

## 7. Realistic dates (assumptions: decisions on the W0–W3 dates above; one implementation stream, two worktrees at most; no major review findings)

| Release                                | Estimate after approvals                                                                                                                                                | Best case         | Likely              |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- | ------------------- |
| **R1 controlled pilot**                | 35–56 working days (documented 8–12 for pilot hardening + register / X / Z 12–20, POS credit / refund screens 9–14, staging ops 6–10 — the last three are my estimates) | **late February** | **early–mid March** |
| **R2 valued inventory + B1 + returns** | 44–64 days, partly parallel with R1                                                                                                                                     | **late March**    | **mid-April – May** |
| **R3 customer web (basic)**            | 15–25 days + review                                                                                                                                                     | **April**         | **May**             |

**February is possible only for R1, and only if the decision session happens this week or next and reviewers are named immediately.** Calendar risk to verify: Ramadan 2027 begins around 8 February and Valentine's Day (a florist peak) is 14 February — avoid a cut-over in that window.

## 8. What can proceed now without waiting for approvals

Frontend work on the **active, frozen** contracts (POS on-credit / advance sale, refund screen over existing routes, Owner Web receivables and customer-credit views); browser journeys; the PR-slice plan; staging IaC and the load-test harness; the Phase 4 / inventory decision session agenda; offline Class B **design** (no code); public-API threat model for the customer website. **Stop** adding inert foundation (more drafts, mutation sweeps of unwired code) unless it is on the path above.

## 9. Owner decisions, in order (all unticked)

- [ ] **D-SCOPE** — R1 pilot with availability-only stock in February, R2 inventory after (explicit reversal of 2026-11-15), **or** full inventory scope with the April date
- [ ] **D-COMMIT** — authorize branches / PRs / pushes for the uncommitted work (the first and cheapest unblocker)
- [ ] **D-PEOPLE** — name the independent security reviewer and independent accountant
- [ ] **D-HOST** — hosting / region for staging and production
- [ ] **D-OFFLINE** — confirm Z-6 online-only for the first release
- [ ] Batch 1: R-1, F-6, F-1, F-3, F-7, CI workflow · PR #41 O1–O10 · Phase 4 package · **D-ORDER**
- [ ] R2 batch: C-7, C-8, C-3 (+ I7-1…5), PR-1…8, D-1a/b/c; accountant C-2 + A-items

## 10. Next executable task (no approval needed)

**POS customer sale on credit and with advances**, on the unchanged `complete-sale` contract: the POS must send `paymentIntent: ON_CREDIT` / `PAY_NOW` with `advances`, show the customer's balance and advances, surface refusals, print balance due on the receipt. Frontend and api-client only; no migration, no frozen file. Acceptance: unit tests for the pure plan, component tests, a browser journey (customer sale on credit → invoice outstanding → later payment) against the real API. _(Releasing it to cashiers still depends on F-1 / F-7.)_
