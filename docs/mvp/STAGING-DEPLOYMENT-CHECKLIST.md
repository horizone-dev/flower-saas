# Staging deployment checklist for the December internal alpha (2026-11-18)

**Nothing here has been run on a host.** No staging host exists (decision **D-HOST** is open), no credential exists in the repository, and no deployment is authorised. Every command below exists in the repository at the #49 tip (`infra/staging/*`, `infra/migrate/*`) and was exercised **locally in Docker only** (`RELEASE-RUNBOOKS.md` §7–§8). Items marked **OPEN** have no answer yet; none of them is invented here.

## 0. Entry gates (all must be true before the first command)

| #   | Gate                                                                                                                                                                   | Status                                                          |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| E1  | Owner decision D-HOST: a host, who administers it, where it lives                                                                                                      | OPEN                                                            |
| E2  | R-1 (or a KMS provider) built into the API image, otherwise production mode refuses to start (`SECRETS_PROVIDER=dev` is rejected; `kms` has no provider)               | OPEN (R-1 approval)                                             |
| E3  | PRs for R-1, F-6, M-1, F-1a, F-7b, F-7c and the manager gate merged **in the order of `DECEMBER-ALPHA-INTEGRATION-SEQUENCE.md`** and CI read honestly after each merge | OPEN                                                            |
| E4  | PostgreSQL version decided and pinned (§2)                                                                                                                             | PROPOSED (17.11 + digest, mechanism built); owner approval OPEN |
| E5  | A named independent security reviewer and a named accountant                                                                                                           | OPEN                                                            |
| E6  | F-1 owner attestation that **no workspace was provisioned before F-1a** (alpha uses newly provisioned workspaces only)                                                 | OPEN                                                            |

## 1. Hosting requirements

- One Linux host with Docker Engine and the Compose plugin; the stack is Compose project `flower-staging` (postgres, redis, minio, backup, migrate, roles, seed, api, pos, owner-web, caddy; `bootstrap-operator` behind the `bootstrap` profile). **Sizing has not been measured**; pick it from a first deployment and record it, do not assume.
- Public DNS A records for three names, ports 80 and 443 reachable from the internet (ACME): `POS_HOST` (till), `OWNER_HOST` (Owner Web), `OPS_HOST` (operator). Only Caddy publishes ports.
- `OPS_HOST` serves **only** `/v1/platform/*` and **only** to `ADMIN_CIDR` (a real office/VPN egress range, never `0.0.0.0/0`). The staff-invite route (F-7b) is on this host.
- The till host blocks the platform realm; the API runs as the non-superuser `flower_app` (RLS enforced) and a separate audited `flower_platform` role.
- Disk for the PostgreSQL volume, the `flower-staging-backups` volume **and an off-host copy of the backups (OPEN: destination, encryption, retention, RPO/RTO are owner decisions)**.

## 2. PostgreSQL version pin — PROPOSED, awaiting owner approval (gate E4)

**Mechanism (built, verified):** `infra/staging/postgres-image.pin` holds the ONE reference; `postgres` and `backup` both use `${POSTGRES_IMAGE}`. `preflight.mjs` refuses `postgres:17`, `:latest`, a bare major, another major, a variant tag, **a tag without a digest**, and any value that differs from the pin file (a plain `17.<minor>` tag is accepted only with `--local`); it also refuses a pin file that is weak or missing. `check-release.mjs` re-checks the **resolved** compose (both services, same image, equal to the pin). The CI workflow has three negative steps that check each refusal **for the right reason**; 10 mutants of these guards were each caught (see the PR description).

**Proposed value:** `postgres:17.11@sha256:ff87138949ad9a46f32ff23bd6852b52ce024a13dffe9b4087be98292cdd3b4f` (registry index digest, linux/amd64 + arm64; PostgreSQL 17.11 on Debian 13, `pg_dump`/`pg_restore` 17.11 in the same image). **Alternative:** `postgres:17.12@sha256:97fb53376be3e4fb1a8a61421daa69dcc3bf2fa39bda3259f5245f9a455af1a9`, a one-line change of the pin file.

**Safety assessment of 17.11 (facts from postgresql.org on 2026-11-27, and from this repository):**

| Question                              | Finding                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Is 17.11 the current minor?           | **No.** 17.12 was released 2026-11-12; 17.11 on 2026-08-13. PostgreSQL's policy is to run the current minor. Major 17 is supported until 2029-11-08.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| What does 17.12 fix that 17.11 lacks? | About 48 CVE-identified issues: use-after-free and buffer overruns (some reachable with crafted input to `ts_rank_cd`, `tsvector_delete`, COPY, portals), **two row-level-security fixes** (`ON CONFLICT` evaluated user quals before RLS policies, CVE-2026-120154; `DROP OWNED BY` removing restrictive RLS policies from tables the role does not own, CVE-2026-116311) and one view fix (`ON CONFLICT DO UPDATE` through a view could reach rows the view hides, CVE-2026-16237), privilege-check gaps (casts in `to_json()` and foreign-key checks) and PL/Perl, PL/Tcl, dblink and pg_restore hardening. Individual CVSS scores were not assessed here.                                                              |
| Practical exposure in staging         | Almost all of these need an authenticated session that runs crafted SQL. The API connects as the non-superuser `flower_app`, queries are parameterised, and only Caddy publishes a port (`check-release` and `smoke-local.sh` assert 5432 is not published). The realistic path is therefore **application SQL injection first**, then these bugs as escalation; this repository's tenant isolation depends on RLS, and two of the fixes concern RLS policies directly (an attacker needs to control SQL text, such as a crafted qual in an `ON CONFLICT` statement or a `DROP OWNED BY`, which the application does not allow unless it has an SQL-injection flaw; this was reasoned from the release notes, not tested). |
| Data-integrity fixes that apply to us | The two **GIN trigram indexes** on `product."nameEn"` and `product."nameAr"` (GIN VACUUM and posting-tree bugs can make a search miss rows): `REINDEX` them if staging runs 17.11 for long. **Do not apply:** no `bpchar`/`CHAR(n)` column, no GiST trigram index, no `REINDEX CONCURRENTLY`, and **no incremental backups** (the backup job is a plain `pg_dump -Fc`, so the 17.12 warning about incremental backup files does not touch it).                                                                                                                                                                                                                                                                             |
| Why 17.11 at all                      | It is the only version on which every frozen report performance gate passes (Finding A is a 17.12 plan regression, PR #50), and it is what the CI test stack pins (#51). Staging on 17.11 keeps staging and tests on the same engine. Finding A was measured on large synthetic ledgers; it has **not** been measured at alpha data volumes.                                                                                                                                                                                                                                                                                                                                                                               |
| What the digest costs                 | A digest freezes the OS layer: `postgres:17.11` was rebuilt on 2026-11-05, so a floating tag changes silently and a digest never receives Debian fixes. Refresh the digest deliberately (`docker buildx imagetools inspect postgres:17.11`), review, then change the pin.                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

**Conditions I recommend if the owner approves 17.11 for staging** (each is the owner's to accept or change): staging only, never production; the database stays unreachable from outside the compose network; the two GIN indexes are reindexed before any search-quality check; the decision is **time-boxed**: re-decide when the next PostgreSQL minor is released or before any user outside the internal alpha, whichever comes first. The deferral of the Finding A amendment makes 17.11 a growing security debt; the exits are a verified bounded variant of the amendment (PR #56 lists the options) or accepting 17.12 plan behaviour.

### 2a. Deferred issue — PostgreSQL 17.12 report-plan regression (Finding A / B): **OPEN, DEFERRED by the owner on 2026-11-27 (option 1)**

This pin does **not** resolve it; it only keeps staging on the engine where the frozen report gates pass.

- **What:** on PostgreSQL 17.12 two frozen report probes change from an index scan to a per-row sequential scan: sales `creditNotesWithoutRevenueJournal` and tender-totals `allocatedPaymentsWithoutReceiptJournal` (`LEFT JOIN LATERAL … LIMIT 1 … IS NULL`). Finding B (dense-window JIT) is cleared by the same change. On 17.12 the frozen performance tests fail (8–10 tests in 3 report files); on 17.11 they pass.
- **Evidence kept:** PR #50 (plan comparison, 17.11 vs 17.12), PR #51 (CI test stack pinned to 17.11, `verify` green), PR #56 (the `NOT EXISTS` rewrite, **DRAFT / BLOCKED, review only, not merged**; its bounded-read tests are **not weakened**: the F-1 tender repro reads about 60,000 rows against bounds of 515–620, and F-2 sales is likewise an open measured finding of that candidate).
- **Unchanged by design:** the frozen financial SQL, and the 25,000-document density protection (`SALES_REPORT_MAX_DOCUMENTS`).
- **Digest note:** the `postgres:17.12` tag was re-pushed after the local images used for that evidence were pulled (index digest `0d938e97…f6ac` then, `97fb5337…af1a9` in the registry on 2026-11-27). The numbers above were measured on the earlier build; re-measure on the exact digest if 17.12 is ever chosen.
- **To close it:** an owner-approved decision on the frozen SQL amendment (a verified bounded variant, PR #56 lists the options) or an owner decision to accept the 17.12 plan behaviour, then a re-measurement on the chosen digest. Until then this section and PR #56 are the record.

## 3. Secrets and KMS prerequisites

- Copy `infra/staging/.env.example` → `infra/staging/.env.staging` (git-ignored, `chmod 600`) and fill **every** value. `node infra/staging/preflight.mjs infra/staging/.env.staging` refuses placeholders, short or reused secrets and a floating image tag.
- Distinct random values (≥ 24 characters; `openssl rand -hex 32`): `POSTGRES_SUPERUSER_PASSWORD`, `APP_DB_PASSWORD`, `PLATFORM_DB_PASSWORD`, `REDIS_PASSWORD`, `MINIO_ROOT_PASSWORD`, `AUTH_JWT_SECRET`. Store them in the operator's password manager, not in chat or in the repository.
- `SECRETS_PROVIDER=disabled` (R-1): fail-closed, the vault can never hold or reveal a secret. Consequence for the alpha: **no tenant can store a payment, WhatsApp or other provider credential**. That matches the alpha scope (cash, recorded card tender, credit; no provider integration). A KMS provider is a separate decision and **not** an alpha prerequisite. State this to the owner so nobody expects stored integration keys.
- The first platform operator is created with `docker compose --profile bootstrap run --rm -it bootstrap-operator --email … --name "…"` (interactive, refuses without a terminal, password read hidden, TOTP shown once and stored only after a live code).

## 4. TLS

- Caddy obtains certificates automatically (`CADDYFILE=./Caddyfile`); `Caddyfile.local` is for the local smoke only.
- Check after first start: HTTPS on all three names, HSTS present, TLS 1.2+ only, `http://` redirects, `OPS_HOST` unreachable from outside `ADMIN_CIDR`, the platform realm refused on `POS_HOST`. (`smoke-local.sh` already asserts the same against a local stack.)

## 5. Backup and restore

- `backup` (a verified `pg_dump -Fc`) runs **before** `migrate` on every start. Never skip it.
- **Restore drill before the alpha opens, on the real host:** restore the newest dump into a **new** database (`pg_restore --no-owner`), compare row counts and the schema fingerprint, then point `POSTGRES_DB` at it only if recovering. Never restore over the live database. Locally rehearsed; **not yet rehearsed on a host**.
- Record backup time, size, restore time. Those numbers are the RTO evidence an accountant will ask for.

## 6. Database migration order

1. Build the migration image from a **clean committed tree** and tag it with the commit. Keep `release-images.json` (`node infra/staging/release-images.mjs infra/staging/.env.staging --out release-images.json`).
2. `MIGRATION_MODE=check` first: read-only report of pending approved migrations. The runner refuses a folder that is not in `infra/migrate/approved-migrations.json` (a draft, an uncommitted Phase 4 migration, a changed file hash).
3. `MIGRATION_MODE=deploy docker compose … up -d` applies the approved migrations in folder-timestamp order, then `roles` sets the application passwords, then `seed`, then `api`.
4. At the #49 tip the manifest lists **49** approved migrations, ending `20261010120000_phase_3b8_currency_and_release_integrity`. **None of the December candidates adds a migration**: verified by script, no patch (R-1, F-6, M-1, F-1a, F-1 pins, F-7b, F-7c, gate) touches a `migrations/` folder, `schema.prisma` or a `.sql` file. Phase 4 migration 51 and every `DRAFT-*.sql` stay outside the manifest and the runner refuses them.
5. The F-1 **data** migration for pre-existing workspaces (`DRAFT-F1-cashier-sales-catalog-view.sql`) is **not** part of the alpha: new workspaces get `catalog:view` from the role template.

## 7. Cashier onboarding (the alpha path)

1. An operator on `OPS_HOST` (platform realm, `platform:tenant_users:manage`, **step-up MFA**) provisions a workspace, then invites staff with route A: `POST /v1/platform/tenants/:tenantId/staff-invites` (roles `cashier`, `sales`, `manager`; scope is one company and one branch).
2. The response carries a one-time `setPasswordToken` (24 hours, single use, stored hashed, `Cache-Control: no-store`). **Delivering it is a human step (OPEN: channel).** Hand it over in person or through a channel the owner approves; never paste it in a ticket.
3. **There is no set-password screen in any app** (verified: no page or client call in POS, Owner Web, Super Admin or Customer Web; only `POST /v1/auth/set-password` and an API-client method exist). Until a screen is built (**OPEN, next engineering task**), the operator completes this step with the API on the staff member's behalf, in front of them, so the chosen password is never typed into a ticket or chat. Then the staff member signs in on the till. A cashier needs no MFA (owner decision); a **manager** must enrol an authenticator **in front of the operator**, immediately, before being given any duty (Owner Web has a Security page for it, `POST /v1/auth/mfa/enrol` + `/confirm`, and the API accepts both calls from an enrolment-only session; **the page itself was not exercised in a browser with an enrolment-only session**, the harness enrols through the API: verify it in A6). Until enrolment is **confirmed** and the manager signs in again, the manager can do nothing financial (the gate).
4. Operator checks: the cashier sees the catalog (F-1a), a sale takes cash or recorded card, a second cashier cannot see the first one's workspace (cross-tenant check with two workspaces).
5. There is **no invite revoke and no re-issue** and **no MFA reset** in the code today. A mistyped email or a lost authenticator is an operator-with-database-access problem. **OPEN** (see `MANAGER-MFA-GATE-REVIEW.md`).

## 8. Financial reconciliation (what exists now)

Reports available through Owner Web and the API: sales and VAT report, tender totals, receivables current state ("Who owes us"), customer advances and unapplied receipts, trial balance (API; no Owner Web screen). **Not part of the alpha:** cash-drawer reconciliation and X/Z reports (Phase 4, routes inert; cash sales write no register movement).

Daily procedure for the alpha, to be agreed with the accountant:

1. Sales report gross, VAT and net for the day equals the sum of the day's invoices.
2. Tender totals per method equals the sales report's paid total; cash is counted on paper until the register is wired.
3. Receivables control equals the sum of open balances per customer; advance liability is shown separately and never netted.
4. A sample of at least 10 invoices per day is recomputed by the accountant against the VAT rules (F-6 refuses an unclassified product for a sale).
5. Any difference is recorded and explained; nothing is "absorbed".

## 9. Rollback

Forward-only migrations: an application rollback is only valid if the previous image runs on the migrated schema.

1. Stop sales (the till is online-only; use the paper log of `PILOT-RUNBOOK.md` §7).
2. Application rollback: previous image tags in `.env.staging`, then `MIGRATION_MODE=check docker compose … up -d api pos owner-web caddy`.
3. Data rollback only if the data is wrong: run `backup` first, restore into a **new** database, compare, repoint `POSTGRES_DB`.
4. Revert-forward in git for any bad merge; no history rewrite, no force-push.
5. Smoke: `/readyz` all `ok`, one sale, one reprint, the Owner sales report. Record cause and timings. **Not yet rehearsed:** redeploying a previous good image set.

## 10. Acceptance gates (each ends with evidence kept with the release)

| #   | Gate                                                                                                                                                                                                                    | Evidence   |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| A1  | `preflight.mjs` and `check-release.mjs` exit 0 against the real `.env.staging`                                                                                                                                          | output     |
| A2  | Images built from a clean tree, tagged with the commit, IDs in `release-images.json`                                                                                                                                    | file       |
| A3  | `MIGRATION_MODE=check` lists only approved migrations; `deploy` finishes; the API reaches `/readyz` all `ok` in production mode                                                                                         | logs       |
| A4  | TLS, HSTS, host isolation, `OPS_HOST` CIDR restriction verified from outside                                                                                                                                            | output     |
| A5  | Backup taken and **restored into a new database on the host**                                                                                                                                                           | counts     |
| A6  | Operator bootstrap with TOTP; a workspace provisioned; a cashier and a manager onboarded through route A with **no SQL-seeded step**; the manager is refused every financial route before enrolment and passes after it | transcript |
| A7  | Journeys J1 to J9 (`DECEMBER-ALPHA-EXECUTION.md` §3) pass on that host, with E-5 (J7) and the GL screens (J9) explicitly out of scope                                                                                   | report     |
| A8  | Two workspaces: no cross-tenant read, write or realtime topic (probe suite green)                                                                                                                                       | suite      |
| A9  | Secrets not present in any log (redaction check), `SECRETS_PROVIDER=disabled` verified                                                                                                                                  | output     |
| A10 | Independent security review and accountant review of the alpha scope signed by **named humans**                                                                                                                         | sign-off   |

No acceptance row may be marked "done" by engineering alone: A10 needs the two reviewers, and A5 and A6 need the host.
