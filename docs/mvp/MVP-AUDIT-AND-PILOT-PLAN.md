# Flower SaaS — Pilot MVP audit, scope and release plan

Status: **2026-11-14 · working notes, UNCOMMITTED** (worktree `fwt\p4`, branch `phase-4/cash-register-foundation`).
Nothing here declares Phase 3B closed, nothing is merged/deployed, and **the MVP is NOT declared ready** (release gates below are open).
All percentages are **estimates**, not measurements.

## 1. Feature-by-feature audit (backend AND frontend)

Legend: ✅ implemented · 🟡 partial · 🖥 backend only, frontend missing · ⛔ approval-blocked · ❌ absent

| #   | Pilot feature                      | Backend                                                     | Frontend                                               | Class | Evidence / gap                                                                                                             |
| --- | ---------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------ | ----- | -------------------------------------------------------------------------------------------------------------------------- |
| 1   | Company / branch setup             | ✅ org module, scoped                                       | ❌ Owner Web                                           | 🖥     | API exists; no Owner UI (setup can be done by a platform seed/runbook for ONE shop)                                        |
| 2   | Staff login + roles                | ✅ login/refresh/logout, RBAC, system roles                 | ✅ POS login/sign-out (new)                            | 🟡    | **No staff-creation route**; **`cashier` role lacks `catalog:view`** (finding F-1)                                         |
| 3   | Products / variants / pricing      | ✅ catalog, UOM, company + branch prices, tax category      | ❌ Owner Web                                           | 🖥     | **No product images** (absent in model/API)                                                                                |
| 4   | Stock mgmt & deduction             | ❌ no inventory module; only a per-branch availability flag | ❌                                                     | ❌    | Phase 5 scope; MVP uses the availability flag only (F-2)                                                                   |
| 5   | POS product selection / cart       | ✅ server prices/totals                                     | ✅ new (touch grid, search, cart)                      | ✅    | real-browser E2E                                                                                                           |
| 6   | Customer selection                 | ✅ customers                                                | ✅ new picker (+ walk-in)                              | ✅    | real-browser E2E                                                                                                           |
| 7   | Cash & card checkout               | ✅ complete-sale, tenders, idempotency                      | ✅ new (cash/change, card, split, lost-response retry) | ✅    | CARD = recorded CARD_TERMINAL tender (no provider integration)                                                             |
| 8   | VAT invoice + receipt printing     | ✅ invoice + snapshots, 5 % VAT, one balanced journal       | ✅ new receipt (screen/print/COPY)                     | 🟡    | **No cashier-readable seller TRN/address endpoint** → receipt shows `headerIncomplete` (F-3); thermal/ESC-POS not verified |
| 9   | Sales history / reprint            | ✅ orders/invoices                                          | ✅ new list + reprint                                  | 🟡    | list ordering and payments-read endpoint missing (history shows no tender breakdown)                                       |
| 10  | Basic sales reports                | ✅ Task 3b.10 reports API                                   | ❌                                                     | 🖥     | no UI                                                                                                                      |
| 11  | Refunds / cancellations            | ✅ credit notes + local refund + cancel (3b.8)              | ❌                                                     | 🖥 ⛔  | provider refund = 501 by design; UI missing                                                                                |
| 12  | Owner Web product/stock/staff mgmt | partial (catalog yes; stock/staff no)                       | ❌                                                     | ❌    | whole app absent                                                                                                           |

Backend strength: sale → invoice → VAT → payment → balanced GL is proven. Frontends were essentially absent before this session.

## 2. Fastest safe MVP scope

**MUST HAVE (pilot cannot run without):** staff login ✅ · product grid + search ✅ · cart ✅ · customer/walk-in ✅ · cash/card/split checkout ✅ · VAT invoice + receipt ✅ · sales history + reprint ✅ · seller TRN/address for the receipt (F-3) · cashier catalog permission (F-1) · a way to create the cashier staff accounts (runbook seed acceptable for one shop) · catalog loaded for the shop (seed/runbook acceptable) · print verification on the shop's real printer · staging + backup/restore + production security review + release regression/CI.

**PILOT-DEPENDENT (decide with the shop):** refunds/cancellations UI (manager-only; can be done by an operator via API/runbook for week 1) · daily sales report UI · stock tracking (availability flag vs real stock) · product images · Arabic receipt · card terminal integration vs "manual card tender".

**AFTER MVP:** Owner Web, inventory ledger/deduction + GL (Phase 5), offline sales (Class B, Rule 31 keeps financial sales ONLINE-ONLY), delivery/workforce, customer web, e-invoicing adapters (KSA is gated), all Phase 4 register/cash-in/out/count/provisioning work.

## 3. Phase 4 approvals vs the MVP

**None of the pending Phase 4 approvals blocks a cash/card POS pilot.** Cash-register open/count/close, E-5 cash-sales wiring, cash in/out, provisioning routes, device proofs and variance posting are NOT needed to sell, invoice and take payment. They stay inert and unwired (no change made).
Pilot trade-off to state plainly to the owner: without the register/E-5 work there is **no cash-drawer reconciliation**; the shop reconciles the till manually against the sales report.

## 4. Smallest owner-decision set for the MVP

1. **F-1 role template:** approve adding `catalog:view` (read) to the `cashier` (and `sales`) system roles — needs a permissions migration + S0b review. _Until then a cashier sees an empty catalog._ (The E2E rehearsal grants it to the rehearsal tenant only.)
2. **F-3 receipt header:** approve a read-only seller-identity endpoint (legal name, TRN, address) usable with the cashier's permissions, OR print the header from a per-branch setting. Without it receipts are flagged incomplete (not a valid VAT invoice header).
3. **Stock for pilot:** accept "availability flag only, no quantity deduction" for the pilot, or defer the pilot until inventory (Phase 5).
4. **Card:** accept "recorded card-terminal tender (no provider integration)".
5. **Refunds in week 1:** operator-assisted, or fund the UI.
6. **Staff onboarding:** accept a platform runbook/seed for the single pilot shop, or approve a staff-creation route.

## 5. What was implemented this session (evidence)

New POS vertical slice (login → search → cart → customer → checkout → payment → invoice → receipt → history → reprint → sign-out):
`packages/api-client` POS types + methods (23 tests) · `apps/pos-pwa` pure logic + UI (37 vitest tests) · real-browser rehearsal `apps/pos-pwa/e2e` (Playwright + Chromium, Testcontainers PostgreSQL/Redis, real API, real database).

Rehearsal result 2026-11-14: **2/2 Playwright tests passed** and **14/14 database checks passed**:

- sale 1 (cash, customer): one invoice, total 28.88, VAT 1.38 (5 % per line: 1.00 + 0.38), payment CASH 2888, VAT payable credited, journals balance, change 21.12 on the receipt
- sale 2 (split card 6.00 + cash 4.50 with **lost response + safe retry** under the same Idempotency-Key): exactly ONE invoice and one set of payments
- the shop ends with exactly 2 invoices, every journal entry balances; print layout shows only the receipt; sign-out closes the till
- gates: POS `tsc` clean, ESLint clean, Prettier clean, `next build` OK; api `tsc`/ESLint/Prettier clean on the touched harness file; `cash-sales` real-PG integration 32/32 (backward compatibility of the `realClock` option)

Defects found and fixed by the rehearsal: shipped client `fetch` "Illegal invocation" in browsers (api-client) · `NEXT_PUBLIC_API_BASE_URL` not inlined (POS auth) · invoice status `SETTLED` shown raw on the receipt (now "PAID") — all with tests.

## 6. Findings that need an owner/engineering decision

- **F-1** cashier cannot read the catalog (`cashier` role has no `catalog:view`).
- **F-2** no stock deduction exists (no inventory module); availability is a boolean per branch.
- **F-3** seller TRN/address not readable by a cashier → receipt header incomplete.
- **F-4** sales history has no payments read endpoint and no guaranteed newest-first ordering.
- **F-5** a sale with a customer reaches invoice status `SETTLED`, a walk-in sale `PAID` — both fully paid; UI now shows PAID for both (confirm that is the intended server behaviour).

## 7. Pilot release plan (no calendar date — gated)

Critical path: F-1 + F-3 decisions → implement (permissions migration needs approval) → catalog/staff runbook for the shop → thermal printer verification → staging deployment with backup/restore drill → production security review (login throttling, CORS/cookie settings, secrets) → full release regression + CI green → rollback rehearsal → pilot go/no-go by the owner. Release gates NOT yet met: staging, backup/restore, printer verification, security review, full CI regression, the F-1/F-3 decisions.

Remaining work estimate (verified-missing only, **estimate**): F-1/F-3 + role/permission migration + tests ≈ 2–3 working days after approval; stock-flag handling + history ordering/payments read ≈ 1–2; Owner product/price/availability screens (minimum) ≈ 4–6; refunds UI (minimum, manager) ≈ 2–3; reports UI (daily sales) ≈ 1–2; staging/backup/printer/security review/regression ≈ 4–6. **Total ≈ 14–22 working days** of engineering plus owner decision latency; real stock deduction is NOT included (Phase 5).
