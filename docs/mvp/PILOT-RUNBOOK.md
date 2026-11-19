# Controlled pilot — runbook and gates (ONE flower shop)

Status: **2026-11-14 · DRAFT for owner review · nothing here is approved or executed.** No calendar date: every gate below must be met and signed off. Financial sales stay **online-only** (Rule 31): if the network or the API is down, the shop does not sell on the till — it uses the written fallback in §7.

## 1. What the pilot can and cannot do (be explicit with the shop)

Can: staff login · product search · cart · customer or walk-in · cash, card (recorded card-terminal tender, no provider integration) and split payment · VAT invoice with the seller TRN · receipt print · sales history and reprint · owner product / price / VAT-category / availability management · customers.
Cannot yet: automatic stock quantities and deduction (availability on/off only) · refund / cancel screens (backend exists, UI deferred) · reports screens (backend exists) · product images · cash-drawer reconciliation (Phase 4 register work is inert) · staff creation from the app.

## 2. Secure cashier onboarding — CURRENT STATE: BLOCKER

There is **no supported route that creates a tenant user** (only provisioning creates the owner; roles and scope can be assigned to an existing user). The rehearsal creates users with SQL — that is **not acceptable for production**. Smallest fix needing approval and a security review: a platform-realm, audited "create user + one-time invite" route that reuses the existing `set-password` flow, plus the cashier role/scope assignment that already exists. Until then no real cashier can be onboarded.

Interim controls to adopt with it: cashier role = `cashier` (with `catalog:view` once F-1 is approved), scope = exactly their branch, no MFA required for cashiers, **owner has authenticator MFA** (Owner Web asks for a fresh code before organisation screens).

## 3. Printing — what is verified and what is NOT

| Verified (automated, real Chromium)                                                                                                                                                                                                          | NOT verified                                                                                   |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| The receipt in the **print medium** contains: TAX INVOICE title, seller name, TRN, address, invoice number, line VAT, VAT summary, total, the recorded payments; nothing else (no cash-handed-over / change, no UI chrome, no counting aid). | Any **physical receipt printer** (thermal ESC/POS, drivers, paper cut, character set, Arabic). |
| It fits an 80 mm roll (72 mm printable) and Chromium renders it to **one** page (`page.pdf`).                                                                                                                                                | The shop's actual printer model, its driver, margins and print dialog defaults.                |

Pilot gate: print five receipts (cash, card, split, customer, reprint) on the shop's real printer and compare to the on-screen receipt; record paper width and driver. Chrome kiosk-printing (`--kiosk-printing`) is an operator choice and untested here.

## 4. Refund and cancellation handling for the pilot (documented, operator-assisted)

The API supports credit notes, local refunds and cancellation (Phase 3B.8); **no screen exists**, and provider refunds are a deliberate side-effect-free `501`. For week 1: the shop manager asks the operator to execute the cancel / credit note / refund through the API with the `manager`/`accountant` role and step-up MFA; every action is audited; the cashier never refunds. A cash refund is handed over from the drawer and noted on the paper log until the cash-register work is approved. Do not improvise refunds outside the system.

## 5. Backup and recovery

PostgreSQL is the system of record (orders, invoices, payments, the append-only ledger). Required before pilot: nightly logical backup (`pg_dump`) **and** WAL/point-in-time recovery on the managed instance; a **restore drill into a separate database** with a row-count and trial-balance comparison; object-storage and Redis are rebuildable (Redis holds sessions/idempotency cache — a loss logs everyone out and drops the replay cache, it never loses a sale). Recovery objective to agree with the owner (suggest RPO ≤ 15 min, RTO ≤ 4 h). Not done yet.

## 6. Release gates (all must be GREEN; none is claimed green today)

1. Owner decisions in `MVP-AUDIT-AND-PILOT-PLAN.md` §4 (F-1, F-3 applied; user-creation route; stock decision; VAT-category rule).
2. Staging environment with production-like config (HTTPS, real cookie/CORS settings, secrets from the secret store, `NODE_ENV=production`).
3. CI green on the release branch (verify, e2e, realtime, security) **plus** the POS + Owner Web browser rehearsal added to CI.
4. Independent security review of: login/refresh/step-up, session cookies, rate limiting/lockout, CORS origins, the new receipt-identity read, Owner Web server actions.
5. Full release regression on the release candidate (not only the pilot suites).
6. Backup + restore drill passed (§5). 7. Printer verification passed (§3). 8. Tenant/branch isolation probe suite green in CI.
7. Rollback rehearsed: previous API + web builds kept; migrations are forward-only, so any approved migration needs a tested down-path or a feature switch. 10. Owner go / no-go signed.

## 7. Offline / outage fallback (Rule 31)

The till is online-only. If it cannot reach the API: stop selling on the till, take a **paper sale log** (item, price, VAT, payment, time), do not issue tax invoices by hand without a pre-agreed serial range, and enter nothing retroactively until the owner decides how (a controlled offline cash-sale class is architecture-ready but not approved).

## 8. Day-one checks for the operator

Company: legal name, TRN, address set · accounting timezone and an open accounting period · tax rates for the country · every sellable product has **a VAT category** (a variant with none is currently charged **0% VAT without warning**, finding F-6 — Owner Web flags it, but the API does not refuse it) · every product active with a price and unit · branch availability on · cashier scope = their branch only.
