# MVP update — 2026-11-14 (critical-path session)

Status: **UNCOMMITTED working notes. Nothing here is owner-approved. The MVP is NOT declared ready.** Companion files: `MVP-AUDIT-AND-PILOT-PLAN.md` (baseline audit), `INVENTORY-MVP-DESIGN.md`, `PILOT-RUNBOOK.md`.

## 1. Checkout financial correctness (Priority 1)

The API contract is **EXACT-TENDER**. In the rehearsal the browser submitted `CASH 2888` for the 28.88 sale — never the 50.00 handed over. Recorded and verified in the database: payment 2888, invoice 2888, VAT 138, **cash ledger debit 2888**, every journal balanced; the retried split sale produced exactly one invoice.

The misleading part was the UI: "Cash received 50.00 / Change 21.12" existed only in the browser, yet it was printed on the invoice although nothing records it (and a reprint disagreed with the original). Fixed **inside the approved contract**: the printed invoice carries only recorded figures; the change is an on-screen counting aid that says it is not recorded; the checkout labels say so. Tests: unit (receipt model, change aid incl. 3-decimal currencies), browser (request body is exactly `CASH 2888`, aid shown, invoice and reprint agree, aid never printed), database (cash ledger = recorded tender).

Recording cash-handed-over and change would change the frozen payment / cash-movement contracts. That is an owner + accountant decision and was **not** made.

## 2. F-3 implemented (additive, existing authority)

`GET /v1/companies/:companyId/branches/:branchId/receipt-identity` — `orders:view` plus the caller's own company and branch scope; explicit allow-list of non-secret fields (legal names, TRN, registered address, country, currency, branch name); no new permission, no migration. 9 real-database tests: the cashier reads it; the field list is exactly the allow-list; a sibling branch, another company of the same tenant and a foreign tenant are refused with no leak; a role without `orders:view` and an unauthenticated caller are refused. The POS receipt now prints **TAX INVOICE with the seller TRN and address**, read by the cashier. Awaiting owner approval of the route itself.

## 3. F-1 prepared, NOT applied

`docs/decisions/proposed-migrations/DRAFT-F1-cashier-sales-catalog-view.sql` and `DRAFT-F1-system-roles.patch` — read-only `catalog:view` for the `cashier` and `sales` system roles. Validated on a disposable database only: both roles gain it in every tenant, no other role changes, idempotent, FORCE RLS restored, no catalog write permission granted. The S0b baseline facts need the matching update when (and only if) it is approved and applied.

## 4. Inventory (Priority 2)

See `INVENTORY-MVP-DESIGN.md`. There is no inventory schema, no costing method and no inventory/COGS account in the repository, and `complete-sale` is a frozen contract. A quantity-only branch ledger exists as an **inert draft** (draft migration + repository, not applied, not wired): 12/12 real-PostgreSQL tests (25 parallel sales against 10 in stock → exactly 10 succeed; 20 parallel retries → deducted once; rollback atomicity; reversal once; append-only; tenant and branch isolation), 5/5 mutants of the draft caught. It needs decisions INV-1 … INV-6, including the accountant, before it can run.

## 5. Owner Web (Priority 4) — real, no mock screens

Authenticator-MFA sign-in · **step-up** page (organisation reads need a fresh code) · explicit **company choice** (a workspace with several companies is never guessed — the rehearsal hit exactly that hazard: the product was first priced in the wrong company) · products list / create / edit · unit of measure · **selling price in exact minor units** with per-currency decimals · **VAT category** · activate the product, then its variant · availability per branch · "Branch stock" screen (availability flag only, and it says so) · customers list / add. **Staff management is not built: the API has no tenant-side user routes.**

Browser rehearsal across both apps: the owner creates "Peony", prices it at 12.00, sets VAT STANDARD and activates it → the cashier finds it in the POS at 12.00 and the server's checkout shows VAT 0.60, total 12.60 → the owner marks it unavailable at the branch → the POS shows it Unavailable and disabled → available again.

## 6. Printing (Priority 5)

Verified in Chromium: the print-medium content (title, seller, TRN, address, invoice number, VAT, totals, recorded payments; no change, no counting aid) and the 80 mm fit (72 mm printable; the roll is rendered to one page). **Physical receipt-printer compatibility is NOT verified.**

## 7. New and confirmed findings

- **F-6 (financial risk):** a variant with **no VAT category is charged 0% VAT with no refusal** (observed). Owner Web warns, the API does not fail closed. Decision needed: refuse activation or sale without a VAT category (a change to the frozen sale contract — not made).
- **F-7 (pilot blocker):** **no route creates a tenant user**, so there is no secure cashier onboarding (the rehearsal inserts users with SQL — unacceptable for production).
- **F-8:** the organisation list reads need step-up (`settings:tenant:manage`). Correct for security; Owner Web implements step-up. Whether the plain reads should be `@NoStepUp()` is a security decision, not applied.
- **F-9:** the frozen HG17 guard forbids any refund / credit-note artifact in client code, so a refund UI is blocked until the owner deliberately amends that guard.
- F-2 (no stock), F-4 (history ordering / no payments read), F-5 (customer sale → invoice `SETTLED`, walk-in → `PAID`; both shown as PAID) stand as before.

## 8. Verification this session

POS 42 unit · Owner Web 6 unit · api-client 23 · structural pins 1,230 across 33 files (the HG17 guard held) · F-3 9 · stock ledger 12 + 5 mutants · org module integration · browser rehearsal **3/3** (cashier journey incl. print checks; owner → POS) · **16/16** database checks. tsc / ESLint / Prettier are clean for `api` (touched files), `api-client`, `pos-pwa`, `owner-web`; both web apps build. The full API regression suite was **not** re-run (the only shared production changes are the additive org route and its module registration).

## 9. Updated delivery estimate (estimate; verified-missing work only)

Pilot-scope readiness **≈ 70–75 %**: login, catalog, pricing, VAT, checkout, receipt, history, owner product / price / availability and customers are now real and browser-verified end to end; stock, user creation, refund / report screens, hardening and the release gates are not.

Remaining **≈ 26–38 working days** of engineering after approvals — user-creation route + security review 4–6 · F-1 / F-3 apply + S0b 1–2 · VAT fail-closed 1–2 · quantity-only stock incl. sale integration and Owner / POS screens 11–15 · refund / cancel UI (after the HG17 decision) 3–5 · reports UI 2–3 · staging, backup / restore drill, printer test, security review, browser rehearsal in CI, full regression 5–8. Decision latency is not included. If stock is deferred (availability flag only, accepted in writing), subtract 11–15 days.
