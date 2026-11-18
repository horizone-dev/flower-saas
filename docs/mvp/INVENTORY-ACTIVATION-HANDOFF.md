# Inventory read API — decision entries, activation sequence and S-1 reviewer pack

_2026-11-16 · **NOT APPROVED. Nothing is applied, registered or granted.** The recommendations below are engineering's; every decision box is unticked and is ticked only by the named approver, in the diff that applies it. `INVENTORY-APPROVAL-CHECKLIST.md` carries the older line-by-line boxes; this file is the final wording. Technical state: stock 661/661 + the new accountant checks, structural 1,476 (+9 opt-in skips); mutation sweeps caught every mutant._

## 1. The two conflicts, resolved

**Migration M ⇄ D-1a.** M (`DRAFT-M`) creates only the recipe tables (`recipe`, `recipe_component`) and the **build-to-order** consumption / reversal tables (`bom_consumption(_line)`, `bom_reversal(_line)`), plus the database rule that a stock movement can never be booked on a BOM variant itself. Its own header says build-to-stock production has **no table in M** (adding B2 is a later additive migration) and custom bouquets are a different catalog strategy (`CUSTOM`) that M does not touch. The read API and its startup guard need `recipe` / `recipe_component` for the bouquet-availability route. So: **D-1a = yes is exactly the approval M needs, and it removes nothing** — B2 and custom bouquets stay in MVP scope, each under its own decision (D-1b = B2, D-1c = custom). If D-1a were "no", M and the bouquet route would have to leave this activation (a code change: drop the route and two guard entries).

**Accountant role ⇄ O-A.** O-A had excluded the accountant while the C-7 sheet recommended "accountant view + approve". Resolved to the recommended reading: the accountant holds **`inventory:view` + `recipe:view` only (read-only)** — so valuation, cost and movements can be reviewed — and nothing that writes. `inventory:approve` (the "approve" half) belongs to the future write routes and is **not** granted here. The drafts and tests now describe exactly this matrix (still unapproved): Q grants owner / admin / manager / accountant; R (till key) grants owner / admin / manager / cashier / sales and **not** the accountant — proven by tests that fail if the accountant gains any other key, if the cashier gains the view keys, or if the Q backfill and the code templates ever differ.

## 2. Decision entries (exact wording)

**E-1 · C-7 — inventory tables (owner).**
_Apply migrations H, I, K, L, M as real, forward-only migrations, in that order, named after the newest existing migration, together with the DRAFT-P indexes; invert the two inventory pins ("no inventory table", "Prisma schema has no inventory model") in the same diff. Reads stay `409 INVENTORY_NOT_ENABLED` for every company until its costing method is confirmed (C-8)._
☐ Approve as recommended ☐ Approve with changes ______ ☐ Reject — by ________ date ________

**E-2 · D-1a — build-to-order bouquets (owner).**
_A sale of a bouquet defined by a recipe consumes its components at the sale (build-to-order) in the MVP — **yes / no**. A "yes" approves the schema of migration M and nothing else: it does **not** approve or remove B2 (pre-made bouquet production, D-1b — own decision, accountant A-13, own additive migration) or custom bouquets (D-1c — own decision), both of which stay in MVP scope; it does **not** approve the sale hook (I-7 / C-3), cancel restock (I-8), recipe write routes or any journal posting._
☐ Yes ☐ No — by ________ date ________

**E-3 · DRAFT-P — read indexes (owner).**
_Apply `stock_movement_branch_history_idx` and `inventory_lot_branch_expiry_idx` in the same release as the C-7 tables (instant on empty tables; a later build on a large table blocks writes while it runs). Measured on 360 000 movements: movement history 127 → 18 ms per page, batches 66 → 12 ms; the startup guard refuses to boot without them._
☐ Approve ☐ Reject — by ________ date ________

**E-4 · O-A — who may read inventory (owner).**
_`inventory:view` + `recipe:view` → **owner, admin, manager and accountant (read-only)**; nobody else (cashier, sales, florist, storekeeper, … get 403 on the 16 inventory routes; the till route is decided by E-5). I accept that these keys expose **cost, valuation, movement history and reconciliation** to those four roles, that no write key is granted by this change, and that rollback is forward-only (the rollback script also removes later manual grants of these keys; C-7 tables are never dropped once written)._
☐ Approve as recommended ☐ Approve without the accountant ☐ Reject — by ________ date ________

**E-5 · S-5 — the till's availability key (owner).**
_Option **A**: a dedicated `inventory:availability:view`, granted to owner, admin, manager, **cashier** and sales; a till session holding only this key gets `{variantId, tracked, sellable, asOf}` and 403 on every other route — **valuation, cost, batches, movements, documents, adjustments, counts, reconciliation and the bouquet read stay 403 for cashier and sales**. **The accountant is NOT granted this key: after R the till route is 403 for the accountant** (it holds `inventory:view` + `recipe:view` only); giving the accountant till access would be a separate decision. (B: `pos:sell` — couples "may sell" to "may see stock". C: give cashiers `inventory:view` — rejected, exposes cost.) If A: DRAFT-R + its one-constant source edit, and `INVENTORY_REQUIRE_TILL_KEY=1` so the startup guard also requires the key's registry row._
☐ A ☐ B ☐ C — by ________ date ________

**E-6 · Activation go-ahead (owner) — only after S-1 clearance on the §5 hashes.**
_Authorise the activation sequence of §4, step by step; each step is its own reviewed change._
☐ Authorise — by ________ date ________

## 3. Who else must sign

| Item                                      | Needed from                                                                                                                                                                                                                                                                                                                                                                      | Status            |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| E-1 … E-5                                 | Owner                                                                                                                                                                                                                                                                                                                                                                            | open              |
| **S-1** independent security review of §5 | a **separate** reviewer (not the author)                                                                                                                                                                                                                                                                                                                                         | open — pack below |
| Accountant                                | **No approval is required for E-1 … E-5** (reads post nothing; no company has a method until C-8). **Needed later, not now:** C-8 per company (the costing method), C-2 / C-3 / I-3 postings and migration J (the five accounts), A-13 only if B2 is chosen. For E-4 the accountant should be **asked** whether the read-only view is what they need — the owner decides access. | not blocking      |

## 4. Exact safe activation sequence (each step its own reviewed change; none is done)

0. **Pre-condition:** S-1 cleared on the §5 hashes (recompute them — any difference re-opens the review) and E-1 … E-5 recorded, unticked → ticked, in the diff that applies them.
1. **Migrations on a copy of staging first, then staging, then production** — H, I, K, L, M, P, in that order (the manifest `inventory-activation-manifest.json` and its checker fail the build if the order or timestamps are wrong; K / M / P are refused by the database without I). Check: the startup guard's table / column / index checks are green; RLS enabled **and** forced on every new table.
2. **Permissions in one diff** — DRAFT-Q (+ DRAFT-R if E-5 = A), the permission-source edits, the permission-baseline authorisation (reviewed facts hash below), the seed-registry and probe pins. Check: baseline green; role grants equal the matrix; rollback script rehearsed.
3. **Guard dry-run** — run the prerequisite check against the target as the application role; it must report no problem (set `INVENTORY_REQUIRE_TILL_KEY=1` if E-5 = A).
4. **Register the module** (controller + service + startup guard) and import it in the application module, in one diff with the route / probe pins; full suites green. The application refuses to boot if step 1–3 are incomplete.
5. **Staging smoke with a real login per role** — against the matrix of §4a (**before R** and **after R are different matrices; use the one that matches what is deployed**). The same expectations are executed by `inventory-route-matrix.integration.test.ts` for every built-in role.
6. **Staging benchmark** (needs separate owner authorisation to set `INV_BENCH_ALLOW_REMOTE`; command and acceptance proposal in `INVENTORY-PERFORMANCE-CLOSURE.md` §7). Preflight must pass.
7. **Production**, same order. Then, as separate changes: the Owner Web page binding, and the POS availability adapter (after E-5).

### 4a. Smoke-test matrices (two separate states — never mix them)

"16" = the 16 inventory routes (company summary, company valuation, reconciliation, branch summary, branch valuation, stock, lots, movements, documents, document, adjustments, adjustment lines, adjustment, counts, count, bouquet). "Till" = the availability route for the till. Costing confirmed, session branch scope = all branches.

**Matrix A — BEFORE R (S-5 not applied; DRAFT-Q only; the till route still requires `inventory:view`)**

| Role                                                            | the 16 | Till                                |
| --------------------------------------------------------------- | ------ | ----------------------------------- |
| owner, admin, manager                                           | 200    | 200                                 |
| **accountant**                                                  | 200    | **200** (it holds `inventory:view`) |
| cashier, sales, florist, storekeeper, every other built-in role | 403    | 403                                 |

**Matrix B — AFTER R (S-5 option A; DRAFT-Q + DRAFT-R; the till route requires `inventory:availability:view`)**

| Role                                                                                    | the 16                                                                                                                                        | Till                                                                        |
| --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| owner, admin, manager                                                                   | 200                                                                                                                                           | 200                                                                         |
| **accountant** (`inventory:view` + `recipe:view`, **no** `inventory:availability:view`) | 200                                                                                                                                           | **403** `MISSING_PERMISSION` — unless a separate decision grants it the key |
| **cashier, sales** (the dedicated key only)                                             | **403** — including company and branch **valuation**, batches, movements, documents, adjustments, counts, reconciliation and the bouquet read | 200, `{variantId, tracked, sellable, asOf}` only                            |
| florist, storekeeper, every other built-in role                                         | 403                                                                                                                                           | 403                                                                         |

Detail routes (document, adjustment, count): an existing record is 200 for a role that may read; an id that does not exist is `404 STOCK_*_NOT_FOUND`; a role without the key gets 403 before any lookup; a real record asked for under another branch is the same 404.

**Both matrices, other states:**

- **Costing not confirmed** (any company without a confirmed method): a role that holds the key gets 200 without figures from the company summary, the branch summary and the reconciliation (`SKIPPED`), and `409 INVENTORY_NOT_ENABLED` from every other route it may call (including the till route for a till key); a role without the key still gets 403 — the permission is checked before the state.
- **Session limited to one branch:** the path branch is the session's branch → the three company-wide routes (company summary, company valuation, reconciliation) are `404 STOCK_SCOPE_NOT_FOUND`, branch routes work; the path branch is **another** branch → branch routes are `404 NOT_FOUND` (identical to an unknown branch id, no id in the body) and the three company-wide routes `404 STOCK_SCOPE_NOT_FOUND`; a role without the key is still 403 first.
- **Foreign tenant or unknown company:** 404, no figure.

Never: register the routes before steps 1–3; grant a key before its registry row exists; apply P to a large table in business hours; edit an applied migration (recovery is revert-forward).

## 5. S-1 reviewer pack

**Scope of the claim:** the 17 inventory read routes cannot write, cannot cross tenant / company / branch, cannot reach cost or valuation without `inventory:view`, and cannot be registered against an unprepared database.

**How to verify you are reviewing this exact state:** recompute each hash — `tr -d '\r' < <file> | sha256sum` — and compare with the manifest below (this handoff file itself cannot embed its own hash and is the one file not listed; hashes are valid at generation — any later edit changes them and re-opens the review). Run: `pnpm --filter @flower/api exec vitest run src/modules/stock` (Docker needed for the disposable PostgreSQL; includes the 23-test route matrix) and the structural / release gate.

**Reviewed permission facts (with the accountant, current):** Q = 11 facts, `factsSha256 307483ee0d9dee48401c21aff655d9c98522c94c246c5676df85e407cfc1cfac`; R-only = 10 facts, `61fd7e2ffdeccb1c66e1f2e7b9d5eea3a1b36954138a4cbed42d5f40836f2641` (unchanged — the accountant gains no till-key fact); patched sources: Q `permissions/index` `37f473a6…2709`, Q `system-roles` `541f39c4…a771`, Q+R `permissions/index` `2ffb9be3…8b5b`, Q+R `system-roles` `022b4a5a…ddec`. _(Without the accountant these were 9 facts `339e6fc3…c367`, `4ffabb25…0446`, `93d707f4…a9`, `5f5ced80…e76b`, `a590a727…4104`; reverting = remove `accountant` from the Q backfill list, drop the accountant source edit and R's fix-up, and restore those constants.)_

| Claim                                                                                                                                                                                                                                                                                                                                                                                   | Where to look                                                                                                                                                                                         |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tenant / company / branch come from the session only; path ids are validated against it                                                                                                                                                                                                                                                                                                 | `inventory-reads.controller.ts` — `@Controller('companies/:companyId')` (l. 29), `@ScopedParam({ company, branch })` on every route; `assertBranchInCompany` (`inventory-reads.repository.ts` l. 144) |
| Every route declares a permission; 16 need `inventory:view`; the till route reads `TILL_AVAILABILITY_PERMISSION` (`read-support.ts` l. 18)                                                                                                                                                                                                                                              | controller `@RequirePermission`; `inventory-activation-contract` ("permission keys")                                                                                                                  |
| Every route × every built-in role, **separately before R and after R**: the accountant is 403 on the till route after R; cashier / sales reach only the till route (never valuation or any other read); existing / nonexistent / permission-denied record cases; branch scope (all, own, another branch, out-of-scope = same 404 as an unknown branch); costing confirmed / unconfirmed | `inventory-route-matrix.integration.test.ts` (role permissions read from the proposed patched role source; expectations hand-written, both costing methods); matrices in §4a                          |
| All 17 are GET; the transaction is READ ONLY, REPEATABLE READ, as the application role under forced RLS                                                                                                                                                                                                                                                                                 | `read-snapshot.repository.ts` l. 24 `SET LOCAL ROLE`, l. 27 `SET TRANSACTION READ ONLY`, l. 30; test "a read can NEVER write" (ledger hash unchanged)                                                 |
| Company-wide figures only for unrestricted, un-narrowed callers (decorators pinned to reports, so the rule lives in the service)                                                                                                                                                                                                                                                        | `inventory-reads.service.ts` `companyWide` (l. 49), `requireBouquetAccess` (l. 59); HTTP security matrix (11 session kinds incl. impersonated support)                                                |
| Out-of-scope, foreign and unknown branch/company are indistinguishable (404)                                                                                                                                                                                                                                                                                                            | `read-support.ts` `assertBranchReadable` (l. 58); `loadCompanyRow` explicit tenant filter (`inventory-reads.repository.ts` l. 103), tested with RLS bypassed                                          |
| Strict query: unknown / repeated / smuggled scope keys, limit > 200, oversize or forged cursors rejected, nothing echoed                                                                                                                                                                                                                                                                | `read-support.ts` `clampLimit` (l. 68), `decodeCursor` (l. 93); `.strict()` schemas in `packages/shared-types/src/index.ts`; HTTP suite                                                               |
| Inert until a method is confirmed                                                                                                                                                                                                                                                                                                                                                       | `enabled()` (`inventory-reads.repository.ts` l. 133): 409 `INVENTORY_NOT_ENABLED`, parity-tested against the ledger's own gate                                                                        |
| Planner settings cannot leak or change results                                                                                                                                                                                                                                                                                                                                          | `indexOrdered` (same file l. 63); `inventory-planner-settings.integration.test.ts` (19 tests)                                                                                                         |
| Permission surface diff = exactly the listed facts, nothing removed; cash-register / device policy intact; accountant read-only                                                                                                                                                                                                                                                         | `activation-rehearsal` + `activation-review`; `inventory-activation-contract` (keys the code names = keys Q + R add)                                                                                  |
| Default role grants equal the code templates; custom roles untouched                                                                                                                                                                                                                                                                                                                    | `activation-review` "role-template parity and rollback"                                                                                                                                               |
| New tables are tenant- and branch-fenced                                                                                                                                                                                                                                                                                                                                                | `activation-review` "BRANCH / TENANT ISOLATION of the C-7 tables"                                                                                                                                     |
| Startup cannot succeed against a half-prepared database                                                                                                                                                                                                                                                                                                                                 | `inventory-startup-guard.ts`; its integration test (bare → each draft → prepared; five broken-prerequisite cases)                                                                                     |
| Not touched                                                                                                                                                                                                                                                                                                                                                                             | `@RequireAllBranches` / `@RequireAllPermissions`, `MODULE_OF_PERMISSION`, device pins, every financial module; two additive pin amendments (probe prefixes +2, seed list +1)                          |

Known limits to accept: `inventory:view` has no module entitlement (basic stock is foundational); after M, a variant with an ACTIVE recipe cannot carry stock (database rule, by design for build-to-order); planner switches are transaction-local and restored to their prior effective values.

### File manifest (LF-normalised sha256)

```
### Code under review (inert: registered in no module)
f42d51bf9144920015d2c7c557180d2be5f6ed4dba708294e2bb3ab973282d27  apps/api/src/modules/stock/reads/inventory-reads.controller.ts
d7b18b61fdeee8461ab4b814f9eaa40e34ec8bc4469fd7b317b5c0be4689bf52  apps/api/src/modules/stock/reads/inventory-reads.service.ts
fe4e174e9b46bf623e730d25c3c96422675e69f478587345b36f4dcc11e9ce6d  apps/api/src/modules/stock/reads/inventory-reads.repository.ts
568a7fb633dd903f97c29d6197ef59c59c805316893f94db2f3e766b78a4a501  apps/api/src/modules/stock/reads/read-support.ts
8c0ce8a72c8f7f2be971a29e75bd0f6595f700198366ba71f7b127a14f6c2597  apps/api/src/modules/stock/reads/read-snapshot.repository.ts
9b0e5da87b021996515f230bcb2e9af6aadcfd78dca736625a2e5575a01182fd  apps/api/src/modules/stock/reads/read-contracts.ts
05898bc0d0293855f387880660b23b4d817f495605f9b3c81e42aba3d5b7c13f  apps/api/src/modules/stock/reads/inventory-startup-guard.ts

### Proposed migrations and permission edits (not applied)
90b380898f3ba0919549bf2dca4a0db1474041de04715c57f4d35e78486dc69d  docs/decisions/proposed-migrations/DRAFT-H-company-inventory-costing-method.sql
0437ec1d9d7eb65c2261dead9c8583a99ac953af544edc212615caa68970b3d2  docs/decisions/proposed-migrations/DRAFT-I-valued-inventory-ledger.sql
c927420d501a2ac02c9784c9c2a6be03d673a6579ce3092301c4baa6a580e493  docs/decisions/proposed-migrations/DRAFT-K-stock-documents.sql
8777f657af88dd28ab3b797e0887c72a0bc01661dec5ab8a44280a9da08b881c  docs/decisions/proposed-migrations/DRAFT-L-stock-adjustments-and-counts.sql
27e60beac56b3cfb92f19328e87093b9865a1465d2ce14c8aa69ac71596e2812  docs/decisions/proposed-migrations/DRAFT-M-recipes-build-to-order.sql
3bc71f64efc3f374af6bfc27d8b0036abc78f69675d406ce5ce4360f19e65180  docs/decisions/proposed-migrations/DRAFT-P-inventory-read-indexes.sql
3440c7d53771be66b1ad155472793cdf243858290a5bc2eb9ae43a501f3de3c8  docs/decisions/proposed-migrations/DRAFT-Q-inventory-read-permissions.sql
4f8230eadd2e9a9a77bc2d16a2aa2ea9113f57b743bdbd5294919af4aaec71c3  docs/decisions/proposed-migrations/DRAFT-R-till-availability-permission.sql
8435dcdd06ed9aa8bac9a98b9d12702c156b8c44bc7d13cf8b9762494d30e50d  docs/decisions/proposed-migrations/DRAFT-QR-rollback.sql
718745dfb86880af36df746c982ae2e2c48d1dad9d108ef39ed92c7764dea929  docs/decisions/proposed-migrations/DRAFT-Q-source-edits.json
80c440b25990d2d8e5fe589d46d4b36a702f57c397fffa7c93c2459224cffb70  docs/decisions/proposed-migrations/DRAFT-R-source-edits.json
92da3659448fd09acafb575995ac5df1c8da40d4c94b56f0af765798c2725296  docs/decisions/proposed-migrations/inventory-reads.module.ts.txt
53abcc05a226ab0db760da14c241ff730330c9063f91fce7a944be7e3df8c49c  docs/decisions/proposed-migrations/inventory-activation-manifest.json

### Evidence (tests)
9182c83f995d86321df062bf7f693ad1951424f2a77dee71d16a8c8e2aaaec07  apps/api/src/modules/stock/reads/inventory-route-matrix.integration.test.ts
cb2845f62facedfd3c09fb565a65b3767284267cc828fd94346886c22cdeadef  apps/api/src/modules/stock/reads/inventory-reads.controller.integration.test.ts
9bea6c0d25fa5a729e78eb358f892fbc148dc26ffda7bb8b931f1873d944db70  apps/api/src/modules/stock/reads/inventory-reads.integration.test.ts
bd5e751c27d9017331812d717689844c4084d5e74eace4dea5589c33071499d8  apps/api/src/modules/stock/reads/inventory-search.integration.test.ts
ba5655455d35fad7516f706133227426cad4ef8e5293fc4b8570307d84e6606b  apps/api/src/modules/stock/reads/activation-review.integration.test.ts
eeef8255eea21051f613a529da137f8d46819c00ef667af910e09828e4e23c11  apps/api/src/modules/stock/reads/activation-rehearsal.integration.test.ts
5f2404e2dd96077e302e666ad620cf688629e43f5df45a3af6f079c22a7830f4  apps/api/src/modules/stock/reads/inventory-activation-contract.integration.test.ts
aedebbb268af0ba09cea5998c34a0ca8433bfc8a17409368d06ced43583c3f1e  apps/api/src/modules/stock/reads/inventory-planner-settings.integration.test.ts
2b76895dfc995218d7270e31ad82ae148fe740747faa1c64e577e1b89e63d367  apps/api/src/modules/stock/reads/inventory-startup-guard.integration.test.ts
65d28efd2a51059ae59381e761fbf44baa24e423f423df21667375c2a7dfd95b  apps/api/src/modules/stock/reads/inventory-migration-manifest.test.ts
a03744bfa54c9c533d2d4777eb9d65eeae48269cda6f252116bc7f1e515263cc  apps/api/src/modules/stock/inventory-release-gate.test.ts

### Decision documents the reviewer is shown (this handoff is excluded: it embeds this manifest)
0fcba0c30e9a5a8b077e6a814cc0344e760c458eafb6d653c45b9531894f7d13  docs/mvp/INVENTORY-APPROVAL-CHECKLIST.md
bc2346fd7be4164e242e34a4c97dbf4d4d71efdc1597e2d7261a67f5ac12aa8e  docs/mvp/INVENTORY-API-ACTIVATION-PACKAGE.md
807194d24c15608d56532a4a42a8330893fb2823cfe4f37e5631c85f338324ae  docs/mvp/INVENTORY-PERFORMANCE-CLOSURE.md
```

### 6. Reviewer instructions and verdict form (S-1 is BLOCKED until a separate reviewer is assigned)

**Independence rule.** The reviewer must be a party who did **not** write, direct or operate the implementation — not this AI-assisted implementation, not an agent or session started by it, and not the person who commissioned it. A review by the author, or by a tool launched by the author, is not S-1 and must not be recorded as one. Nothing here is approved or cleared until the reviewer signs below and the owner then ticks E-1 … E-6 deliberately.

**The reviewer must:**

1. **Recompute** every hash of the manifest above (`tr -d '\r' < <file> | sha256sum`) and stop if any differs from the one listed.
2. **Inspect** the code, the proposed migrations (H, I, K, L, M, P, Q, R, rollback) and the tests themselves, not only their result: RLS enabled **and** forced with a tenant policy (and branch fence on the six branch-owned tables) on every new table; tenant / company / branch only from the session; the READ ONLY snapshot; the startup guard; the rollback script.
3. **Run** the suites (command above; Docker needed) and **verify the permission behaviour independently**: the §4a matrices before R and after R — in particular, after R the accountant is 403 on the till route and cashier / sales reach only the till route; the default role grants equal the code templates.
4. **Try to break it**: tenant / company / branch crossing, forged or smuggled scope keys and cursors, impersonated sessions, a half-prepared database, wrong migration order, rollback side effects. Record any vulnerability or missing control, with the file, the evidence and a severity.
5. **Return a verdict** and the findings below. A CONDITIONAL verdict lists each condition; every condition must be closed and the affected hashes re-issued before E-6.

**Verdict form**

☐ PASS ☐ FAIL ☐ CONDITIONAL — reviewer (name / organisation): ______________________ date ________
Manifest recomputed, 34 entries, mismatches: \_\_\_\_ · Suites run: **\_\_** passed / **\_\_** failed
Findings (id · severity · file / evidence · required action): ______________________________________________

Reviewer sign-off: ______________________ date ________ · Owner: ______________________ date ________
