# Full Florist MVP — critical path, parallel streams and the earliest evidence-based window

**Written 2026-11-17. Status: PLAN — not an approval, not a commitment.** Companion to `MVP-RELEASE-PLAN-FEB-2027.md` (audit and P0 table) and `PR-BOUNDARY-PLAN.md` (how the
198 uncommitted entries become reviewable PRs). Nothing here was committed, pushed, merged or deployed. Estimates marked **(doc)** come from approved plan documents; estimates
marked **(mine)** are my own and have not been validated by anyone.

## 0. The scope this plan keeps (no silent reduction)

Super Admin + Owner Web · staff and permissions · complete POS (VAT, cash / card / split, **credit and advances**) · real inventory, purchases, receiving, valuation, COGS ·
bouquets **B1, B2 and custom composition** · returns and refunds · cash register with **X/Z and accounting reconciliation** · **customer booking / ordering website** ·
**essential delivery workflow**. Offline is a separate decision (§6). The 2026-11-15 rejection of an availability-only MVP stands.

## 1. What the evidence says exists today

| Capability                                                        | State (evidence)                                                                                                                            |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Sale engine: PAY_NOW / ON_CREDIT / advances, VAT, receivables, GL | **Active on `main`**; PR #41 hardening open                                                                                                 |
| POS credit + advance payments (this session)                      | **Built, locally verified** — unit, real-API integration, browser journey (§2). Unmerged, unreviewed                                        |
| Owner Web / POS UI                                                | 85 files, **uncommitted only**; browser journeys green locally                                                                              |
| Cash register open/count/close, X-Report, E-5 recorder            | built **inert / unwired**; permissions policy-disabled; accounting decisions open                                                           |
| Inventory valuation, B1, returns, recipe/BOM, reconciliation      | proved on disposable DBs; **inert**; S-1 BLOCKED; migrations unapplied                                                                      |
| **B2 and custom-composition bouquets**                            | designed in docs (B2 6–8.5 d (doc), Track C 8–12 d (doc)); **not built**                                                                    |
| **Purchasing / purchase orders**                                  | receiving + valuation foundation only; PO workflow and supplier payables UI **not built** (scope matrix in `inventory-execution-readiness`) |
| **Customer booking website**                                      | `apps/customer-web` is **3 files (a shell)** — **not implemented**                                                                          |
| **Delivery workflow**                                             | **no schema, no module, no screen** (only ARCHITECTURE prose) — **not implemented**                                                         |
| Online payments for the website                                   | provider ports approved (Z-4), **no vendor selected, no adapter**                                                                           |
| Staging                                                           | **never existed**; no IaC; API cannot boot with `NODE_ENV=production` (R-1)                                                                 |

## 2. Delivered this session (executable, no migration, no frozen-contract change)

**POS customer credit and advance payments on the existing frozen `complete-sale` contract.**

- `packages/api-client`: `PosCompleteSaleInput` gains optional `advanceApplications` / `creditLimitExceptionReason`; new `getCustomerAccountSummary`, `listCustomerAdvances`.
- `apps/pos-pwa`: pure planner `lib/credit-plan.ts` (integer arithmetic, canonical advance order, advisory refusals, exact-payment idempotency fingerprint);
  `checkout.ts` (`completeKeyForSale`, credit/advance refusal messages incl. "applying an advance needs a manager"); checkout dialog (account panel, advances, **On credit** with
  deposit, credit-exception reason, step-up code entry, figures, account-after); receipt shows **Advance applied** and **Balance due (on account)** exactly as the server reported.
- No business rule is in the browser: the credit limit, advance availability, who may apply an advance (`receivables:advance:apply`) and who may grant an exception
  (`customers:credit:override` + step-up) are all the **server's**; the dialog only previews and shows the server's refusal.

Verification (exact commands and numbers are in the session report): api-client 27/27, POS unit 122/122, `tsc` + `eslint` clean, **real-API integration 18/18**
(`apps/api/src/modules/sales/pos-credit-advance.integration.test.ts`: balances, credit receipts, refusals, owner exception audited, advances, idempotent replay),
and the browser journey `apps/pos-pwa/e2e/zz-credit-advance.spec.ts` with database cross-checks in `e2e/run.mjs`.

## 3. Release-blocking fixes, prioritised

All seven patches below **apply cleanly to the current tree** (`git apply --check`, 2026-11-17). None is applied; each needs the named approval first.

| Pri | Blocker                                                                                         | Ready artifact                               | Approval needed                       | Effort after approval |
| --- | ----------------------------------------------------------------------------------------------- | -------------------------------------------- | ------------------------------------- | --------------------- |
| 1   | **Production KMS boot (R-1)** — API cannot start with `NODE_ENV=production`                     | `R1-secrets-disabled-provider.patch` + test  | security reviewer + owner             | 1–2 d (mine)          |
| 2   | **VAT zero-rate classification gap (F-6)** — API can activate an unclassified variant (0 % VAT) | `F6-vat-server-amendment-FULL.patch`         | **owner (frozen-contract amendment)** | 2–3 d (mine)          |
| 3   | **Staff creation (F-7)** — no route to create a cashier                                         | inert service (uncommitted)                  | owner (route + permission) + security | 3–5 d (mine)          |
| 4   | **Cashier catalog access (F-1)** — shipped cashier role has no `catalog:view`                   | `F1-cashier-sales-catalog-view-BUNDLE.patch` | owner (role template + S0b baseline)  | 1 d (mine)            |
| 5   | **POS credit/advance UI**                                                                       | **built (§2)**                               | review only                           | done                  |
| 6   | **Staging provisioning**                                                                        | runbook + preflight pack                     | **owner: hosting / region (D-HOST)**  | 6–10 d (mine)         |
| 7   | PR hygiene (198 entries)                                                                        | `PR-BOUNDARY-PLAN.md`                        | owner authorises branches             | 2–3 d (mine)          |

## 4. Critical path

The longest chain is **governance → staging → migrations on staging → real-money verification**, not coding:

```
D-SCOPE/D-HOST/D-OFFLINE ─► name security reviewer + accountant ─► approve batch 1 (R-1, F-6, F-1, F-7)
      └─► merge PR #41 ─► D-ORDER ─► Phase 4 migrations (51–54) ─► D/Z1/E1 ─► AL1 ─► SE1 ─► Inventory H…R (each on a staging copy)
                    └─► staging provisioned ─► backup/restore drill ─► HG3b latency run ─► independent review closed ─► ACCOUNTANT checks real staging numbers
                                                             └─► pilot cut-over decision
```

Inventory valuation is the long pole **inside** the code: foundation 17.5–25 d (doc) → B1 5.5–9.5 d (doc) → walk-in paid returns 7.5–10.5 d (doc) → Track C 8–12 d (doc) → B2 6–8.5 d (doc) → D-1c 3–4 d (doc).

## 5. Parallel streams (what can proceed at the same time)

| Stream                        | Work                                                                                                                                                                                                              | Depends on                                          |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| **A Governance** (human)      | decisions D-SCOPE, D-HOST, D-OFFLINE, D-ORDER; name reviewer + accountant; approve batch 1                                                                                                                        | nothing — **this is the gate for everything else**  |
| **B Infrastructure**          | staging, IaC, backups, secrets/KMS, CI runner with Docker, monitoring                                                                                                                                             | D-HOST; R-1                                         |
| **C Money backend**           | register wiring (12–20 d (mine)), refunds over existing routes, E-5 wiring (2–3 d (doc)), purchasing + supplier payables                                                                                          | PR #41, D-ORDER, AL1/SE1, accountant                |
| **D Inventory backend**       | foundation → B1 → returns → B2/custom (§4 chain)                                                                                                                                                                  | Phase 4 chain, S-1 approvals                        |
| **E Frontend**                | POS refund + receivables screens (9–14 d (mine)), Owner Web receivables/customer credit, purchasing screens, bouquet composition UI, inventory UI (dormant components exist)                                      | contracts above (the active ones can start **now**) |
| **F Customer web + delivery** | booking website basic (15–25 d (mine)), delivery schema + API + POS/Owner screens + customer tracking (12–18 d (mine)), pay-on-pickup / pay-on-delivery first, online payment only after a vendor is chosen (Z-4) | new migrations ⇒ approvals; D-SCOPE                 |
| **G Review**                  | independent security review (AL1/SE1, R-1, F-7, device/session), accountant review                                                                                                                                | reviewer named — **external lead time unknown**     |

Items that can proceed **without any approval**: POS/Owner Web screens over **active** routes (refund, receivables), customer-web shell + catalog browsing over read routes, browser/CI journeys,
the PR-slice preparation, test and documentation work. Everything that adds a migration, a permission, a route or a financial rule waits.

## 6. Offline — a separate owner decision

- **Recorded policy (Z-6, approved 2026-09-03):** the first release is **online-only for financial and stock-changing sales**. Class B controlled offline cash sale stays architecture-ready behind
  a tenant flag, to be built only after a **separately approved** conflict / numbering / reservation / idempotency / reconciliation model.
- **State of the code:** the PWA precaches the shell only; **no** IndexedDB, queue, offline numbering or reconciliation. The B5.7 operation-proof protocol exists inert.
- **Gap against an offline-first request:** the whole offline sale pipeline (2–3 weeks to approve a model (mine) + ≈ 25–40 working days to build and review (mine)). It is **not** in any date below. It
  cannot be silently substituted for online-only, and online-only cannot be silently substituted for offline-first: it needs the owner's written D-OFFLINE.

## 7. Realistic windows (evidence-based, not guarantees)

Assumptions: owner decisions and batch-1 approvals land by **mid-December 2026**; an independent security reviewer and an accountant are named by then; hosting is chosen; two to three people work in parallel
(streams C/D/E/F). **If the work stays single-threaded, add roughly 40–60 %.**

| Release                 | Content                                                                                                                                                                                | Earliest window               | Main risk                                                                 |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------- |
| **R1 controlled pilot** | Owner Web, staff, complete POS incl. credit/advances, VAT, cash/card/split, refunds over existing routes, register + X/Z (if D/Z1/E1 + accountant clear) — **stock availability only** | **late February 2027**        | approvals/security review slip; staging                                   |
| **R2 valued inventory** | receiving, costing, deduction, COGS, purchasing, B1 bouquets, walk-in paid returns                                                                                                     | **late March – April**        | S-1 / accountant A-items; migration order                                 |
| **R3 Full MVP**         | R2 + B2/custom composition + customer booking website + essential delivery                                                                                                             | **late April – mid-May 2027** | delivery and website are **not started**; online payment vendor undecided |

**Therefore:** a **complete** Full MVP (every item in §0) **before April 2027 is not supported by the evidence**; what _is_ achievable by late February is the controlled R1 pilot, and by
late March a valued-inventory release. To bring R3 earlier the owner would have to (a) decide scope/hosting/reviewers immediately, (b) staff the parallel streams, (c) accept pay-on-pickup / pay-on-delivery for the
first website release, (d) keep offline out of scope.

## 8. Owner decisions that move the dates (in order of leverage)

1. **D-SCOPE** — confirm the full scope with staged releases R1 → R2 → R3 (record the reversal/confirmation of the 2026-11-15 scope correction in writing).
2. **D-HOST** — hosting and region for staging and production.
3. **Name the independent security reviewer and the independent accountant.**
4. **Batch-1 approvals** — R-1, F-6, F-1, F-7.
5. **D-ORDER** — re-stamp the five Phase 4 migrations to `20261204130000..130400`.
6. **D-OFFLINE** — confirm Z-6 online-only for the first release (or commission the offline model).
7. **Website payments** — pay-on-pickup / delivery first, or choose an online payment vendor (Z-4).
8. Authorise branches / PR slices (`PR-BOUNDARY-PLAN.md`).

## 9. Never declared production-ready

Inert modules (register, X-Report, E-5 recorder, device proofs, inventory valuation, B1, returns) are **not** production-ready. Nothing in this repository has been verified on staging. The POS credit/advance
feature is **locally verified only** and unreviewed.

## 10. Update 2026-11-17 (evening) — POS credit & advance verification CLOSED (locally)

- **Browser (one worker, POS only, 23 s):** 5/5 journeys — credit sale with a lost response retried safely; over-limit refusal and part-payment recovery (credit with deposit); no-credit customer;
  cashier refused on an advance; manager advance part-pay + cash, advance-only, and advance + card deposit + remaining credit.
- **Database cross-check: 106/106** — per sale: one invoice, invoice number equal to the one printed on the receipt, tenders, advance applications, one receivable, customer owes
  `total − payments − advances`, and the journal (receivable control = owed, customer-advance liability = advances applied, cash/card legs = tenders, VAT payable, sales revenue = total − VAT, unapplied receipts net 0);
  per customer: outstanding balance and advance usage from the tables alone; no duplicate invoices; every journal entry balances.
- **Regression:** api-client 49, POS unit 122, real-API integration 18, API structural/frozen-baseline batch 545 (this caught and I fixed a frozen **HG17** violation: banned "refund / credit-note" words in new client types and a message), `tsc` + `eslint` clean.
- **Memory-safe mode:** `E2E_FOCUS=credit NODE_OPTIONS=--max-old-space-size=1536 node apps/pos-pwa/e2e/run.mjs` (one Next build, one server, one worker, no Owner Web). The full 11-test rehearsal needs ~2 Next builds + 2 servers and was reaped once for memory — run it only on a machine with headroom.
- **Not browser-verified:** the step-up code panel (an owner exception is verified at API level only; the POS cashier path shows the refusal). **Not verified:** anything on staging; independent review.

**Next executable blocker (no approval, no migration, active routes):** the credit loop is one-way — the till can create balances but cannot collect them. See `FULL-MVP-CRITICAL-PATH` stream E: POS _Customer account_ (balance, open invoices, statement) + **collect payment on account** over `POST …/customers/:id/receipts`, then Owner Web customer credit settings over `PATCH …/customers/:id/account/credit`.

## 11. Update 2026-11-18 — POS customer account + credit collection BUILT and verified locally

**Built on the existing active routes (no migration, no contract change, no approval needed):** POS _Customers_ (lookup) and _Customer account_ — balance, open invoices with total / paid / owes / status, statement, payments applied, advances available, unapplied receipts — and **Collect payment** over `POST …/customers/:id/receipts`, with a printable **payment receipt** and COPY reprint.

**Contract facts that shaped it (verified in code and tests):**

- Methods the server accepts for a collection: **CASH, BANK_TRANSFER, OTHER_MANUAL only — card is deliberately excluded by the frozen contract**, so the till never offers it.
- The server allocates **oldest receivable first** across the customer's queue; the body is only `{amountMinor, method}`. An amount above the balance is kept by the server as _unapplied_ customer money, so the till caps the amount at the balance.
- Permission `receivables:collect` (cashier, sales, manager, owner, admin); reading needs `receivables:view`; branch is THE boundary (another branch's till is denied).
- `Idempotency-Key` is required; the same key + body replays (one payment); a different body under the same key is `IDEMPOTENCY_KEY_REUSED`; concurrent same-key requests record one payment.
- **The server issues NO collection-receipt number** (no field exists on payments). The receipt prints the server's payment id (short) as the reference. **A sequential receipt number needs a contract amendment (owner + accountant decision) — not invented here.**
- There is **no payment read route**, so an older collection cannot be rebuilt from the server: the till keeps the server's own answer for **this browser tab session** (cleared at sign-out) for a COPY reprint; older ones appear in the statement.
- **E-5 (cash-register recording) is inactive**: a cash collection writes **no register movement**. The dialog says so ("not yet linked to the cash-register count") and the receipt makes no register claim; a test asserts zero movements.

**Verification (local only):** api-client 53, POS unit 152, `tsc`+`eslint` clean, real-PostgreSQL integration **14** (collection: partial / spanning / full, FIFO, journal legs, idempotency incl. 6 concurrent same-key and 4 concurrent different-key, permissions, branch / tenant isolation, no register movement) + **18** (credit / advance), API structural batch **545**, browser **13/13** journeys (pilot, VAT guard, credit/advance, customer account) with **147/147** database checks.

**Next executable blocker (no approval, no migration):** _Owner Web customer credit setup._ `PATCH /v1/companies/:c/customers/:id/account/credit` (`customers:credit:manage`, `If-Match`) is active and tested, but **nothing in the api-client or Owner Web calls it** — an owner cannot switch credit on or set a limit without SQL, so selling on credit is not usable in production. Build the Owner Web screen (enable credit, set limit, version-guarded), then an Owner Web "who owes us" view over the active receivables / reporting routes. Then: POS refund / return screens; website + delivery (not started); and the approval-gated items (R-1, F-6, F-1, F-7, staging, collection receipt numbering).

## 12. Update 2026-11-18 (night) — Owner Web customer credit settings + "Who owes us" BUILT and verified locally

**Built on the existing active routes (no migration, no contract change, no approval needed):** Owner Web **Customer page** (`/customers/:id`) and **Who owes us** (`/receivables`).

- **Credit settings:** switch credit on/off and set the limit through `PATCH …/customers/:id/account/credit`. The page sends the _version it was rendered with_ as `If-Match`; a stale tab gets a plain "changed by someone else — reload" message and changes nothing. The save needs `customers:credit:manage` **and a fresh authenticator step-up**: when the step-up has lapsed Owner Web asks for the code and the owner saves again.
- **Server figures only:** balance (company-wide exposure), credit limit, available credit, advances, unapplied receipts, per-branch balances, open and part-paid invoices (with the invoice number printed on the till receipt), statement and payment/allocation history. Limit-used % is a display ratio of two server numbers; the server's "available credit" is shown beside it.
- **Who owes us:** the frozen current receivables report for the company (needs all-branch authority) or one branch — total owed, ledger reconciliation flag, by-branch rows, customers who owe (names read from the customer route; ordered largest-first _within a page_ because the server pages by customer id).

**Contract facts that shaped it (verified in code and tests):**

- **No way to clear a limit** (an omitted limit keeps the stored one; `null` is refused). Disabling credit keeps the limit and the debt. The UI says so.
- The limit is always in the **company currency**; the client never sends one. Zero / negative / decimal-string limits are refused.
- The PATCH has **no Idempotency-Key** — the version is the guard: replaying a successful PATCH conflicts (409), never applies twice.
- **"Overdue" is not supported**: receivables carry an age (`ageDays`) but there is **no due date or payment terms** in the contract, so the screens show age and say so; nothing is called overdue.
- The receivables report is keyed by customer id only (no names, no per-invoice rows). Invoice-level detail comes from the per-branch account routes.
- **A manager or cashier cannot use Owner Web**: the organisation reads (`/v1/org/*`) refuse them (403), so every Owner Web page ends in the error screen — no data, no form. Exact credit permissions are enforced by the API (verified at API level for manager, cashier, owner-without-step-up, admin, foreign tenant, foreign company).
- No limit-exception (override) UI was built: `customers:credit:override` has no route; the override path remains the sale-time one.

**Verification (local only):** api-client **57**, Owner Web unit **166** (19 new), `tsc` + `eslint` clean; real-PostgreSQL integration **11/11** (`owner-credit-management`: enable/raise/disable with the till honouring each, stale + replayed version, strict body, exact permissions + step-up, report vs account vs database, branch-restricted reader, cross-tenant and cross-company isolation, audit rows); browser **8/8** in the new memory-safe `E2E_FOCUS=owner` mode (cashier refused → owner enables after step-up → cashier sells within the limit and is refused over it → stale tab refused → limit raised → sale passes → credit switched off → refused; manager blocked) with **14/14** database checks (account state, version = 1 + saves, one audit row per save, invoices = completed sales only, receivable control in the ledger = amount owed).

**Not verified / open:** the _view-only_ variant of the credit form (customers:view without credit:manage) is not reachable by any seeded role in a browser, so its disabled-controls rendering is **not tested at all** (type-checked only; the server refusal behind it is API-tested); Owner Web shows its generic error screen (not a friendly "not allowed" page) to roles without organisation access — pre-existing behaviour of every Owner Web page; the full 11-test rehearsal with all Owner Web specs together was not re-run; the Next.js / picomatch advisories are still open (owner decision); nothing is verified on staging or independently reviewed.

**Next blocker (now approval-dominated):** a florist still cannot take a paid bouquet back — paid-sale returns exist only as a proven but **inert** service (owner decisions PR-1…PR-8 unapproved), so POS return screens cannot be built on an active contract. Work that needs **no** approval and no migration is thin: the customer booking website (customer-web is a 3-file shell; the public/customer-facing routes it needs must be inspected first) and Owner Web polish. Everything else on the critical path waits on owner / accountant / security decisions: valued inventory + bouquets B1/B2 (Inventory S-1), delivery (no schema → migration), R-1 / F-6 / F-1 / F-7 patches, staging, collection receipt numbering, and the Next.js upgrade.

## 13. Update 2026-11-18 (late) — Customer Web storefront (demo catalog), patch stacks, dependency assessment

**Customer Web:** the backend has **no shopper-facing surface at all** (only health, staff/device/platform auth and a provider webhook are public; no shopper identity, storefront config, published-catalog read, order channel, soft hold, shopper payment start, or delivery schema). So the storefront is a mobile-first English/Arabic (RTL) **demo-catalog** shop — browse, search, variants/option groups, cart, review — whose "Place order" is honestly disabled. Full audit and the 10 missing contracts: `CUSTOMER-WEB-STOREFRONT.md`. Verified: unit 29, browser 6/6 on a 390 px viewport (no API, zero third-party requests). **Nothing about ordering, payment, booking, delivery or stock reservation exists or is claimed.**

**Prepared patches (documented stacks, text-level apply in a scratch overlay):** E-5 wiring → E-5 pins → `PV…after-E5` ✅; PV standalone ✅; registry → D/Z1/E1 pins → AL1 pins → SE1 pins ✅; out-of-order controls fail as they should. The three that failed standalone fail _because_ they are stacked. The DB-backed `rehearse.mjs` rehearsal (writes a throw-away copy inside `apps/api`) was **not** run.

**Dependencies:** `DEPENDENCY-SECURITY-ASSESSMENT-2026-11.md` — Next 16.4.1 → **16.4.6** clears both `next` advisories (latent: no `use cache` anywhere) and was build/typecheck/unit clean, owner 8/8, POS 13/13, storefront 6/6 in a **separate worktree**; **picomatch has no fixed release** (dev-only). Nothing applied to this worktree.

**Critical-path blockers now (all approval- or contract-gated):** shopper backend contracts (identity, storefront config, published catalog, order channel, payment, delivery — several need migrations/security review) · paid-sale returns (PR-1…PR-8) · valued inventory + B1/B2 (S-1) · R-1/F-6/F-1/F-7, staging, collection receipt numbering · Next.js 16.4.6 approval. Executable without approval: Owner Web polish only.
