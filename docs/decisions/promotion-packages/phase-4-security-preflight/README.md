# Security preflight (AL1 + SE1) — READ-ONLY, for an authorized operator

`PREFLIGHT.sql` is one `SELECT` inside `BEGIN READ ONLY … ROLLBACK`. It reads **PostgreSQL system catalogs only** — never `audit_log`, `security_event` or any tenant data — needs **no superuser**, changes nothing, and is meant to be run by **an authorized operator against staging or production with their own credentials**. This repository never connects to either and never asks for credentials. **Do not assume production matches the disposable test environments**: every verdict is derived from the catalog of the database it runs against.

```
PGOPTIONS='-c default_transaction_read_only=on' \
psql "<your connection string>" -X -q -v ON_ERROR_STOP=1 -A -F "$(printf '\t')" --pset footer=off -f PREFLIGHT.sql > captured.tsv
node preflight-report.mjs captured.tsv --env staging --script PREFLIGHT.sql --out preflight-staging.md
```

`PGOPTIONS` is belt and braces (the script already runs `BEGIN READ ONLY`). Give the connection string **only** through your normal secret mechanism (`PGPASSFILE`, `PGSERVICE`, an environment variable set outside the command line) — **never type a password** into the command, and keep `captured.tsv` inside your environment: only the **report** leaves it.

Run it **twice**: once with the connection string used to **run migrations** (so `P21` reports that role's superuser / BYPASSRLS status) and once with any ordinary login. Send the report to the reviewer **unedited** — never hand-edit a capture or a report; the tool redacts the operator's identity and **refuses** (exit 3, naming the reason, never the matched text) a capture that contains a credential, connection string, address, host name or tenant identifier. Staging first; production only after the staging report has been reviewed.

**Minimum access (measured with real `psql`):** `CONNECT` on the database and `USAGE` on schema `public` — both are the defaults every role gets — and **nothing else**: no superuser, no table privilege (the login cannot read `audit_log`, which is why it can never be shown a row). Without `USAGE` on `public` the script fails with `permission denied for schema public`, without `CONNECT` with `permission denied for database`; either gives an empty capture, which the report tool classifies as **UNPARSEABLE**, never as a pass. Do not borrow the application's (`flower_app` / `flower_platform`) credentials for this.

Output columns: `check_id | verdict | subject | observed | expected`. Verdicts: **PASS** matches the expectation · **FAIL** a release-blocker candidate (the reviewer decides) · **WARN** works today but fragile or a defence-in-depth gap · **INFO** a fact, no judgement.

## Classification — PASS, FAIL, WARN, INFO and UNKNOWN

| Class | Source | Rule |
|---|---|---|
| **PASS / FAIL / WARN / INFO** | the script's own `verdict` column | taken verbatim; the tool never changes one |
| **UNKNOWN** | `preflight-report.mjs` | a check the reviewer needs **produced no row**: the object may not exist in that environment (for example no `security_event` view, no `audit_log` partition row) or the check could not run. A `P40` relation with no `P41` guard row is also UNKNOWN. **UNKNOWN is never PASS** — it is a question for the reviewer |
| **UNPARSEABLE** (no report) | `preflight-report.mjs` | the capture is empty, lacks the header, or has non-conforming lines (typically `psql` failed: see *Minimum access*) |
| **REFUSED** (no report) | `preflight-report.mjs` | the capture contains something that must not leave the environment |

Overall, **any FAIL or UNKNOWN is a finding for the independent reviewer**, not a decision made by the tool: the report approves nothing.

## The checks

| Check | Asks | A FAIL / WARN means |
|---|---|---|
| `P01` | PostgreSQL ≥ 15 (`security_invoker`) | SE1 cannot be applied as drafted |
| `P02` | who is running the script | informational |
| `P10` | `flower_app` NOSUPERUSER NOBYPASSRLS · `flower_platform` BYPASSRLS · `flower_migrate` NOSUPERUSER NOBYPASSRLS, all present | a role is missing or has the wrong attributes — the RLS design does not hold |
| `P11` | `flower_app` is not (transitively) a member of any superuser / BYPASSRLS role or of the platform / migration role | the application role can become a role that bypasses RLS |
| `P20` | owner of `_prisma_migrations`, `audit_log`, `login_security_event`, `security_event` | **WARN = a superuser / BYPASSRLS role owns it** (it ran the migrations): FORCE RLS does not bind it and a view / `SECURITY DEFINER` function it owns bypasses RLS |
| `P21` | the role of **this** session | run with the **migration** connection string: WARN = migrations run as a superuser / BYPASSRLS role |
| `P22` | how many `public` relations each owner holds | WARN = a superuser / BYPASSRLS owner holds any |
| `P23` | `SECURITY DEFINER` functions `flower_app` can execute, their owner and `search_path` | WARN = runs as a superuser / BYPASSRLS owner; a *new* name here needs review |
| **`P30`** | **every view / materialized view: can `flower_app` read other tenants through it?** | **FAIL = the SE1 finding** (not `security_invoker`, owner bypasses RLS, `flower_app` can `SELECT`); WARN = isolated only by the owner's RLS binding, or `SELECT` granted to the app role, or a readable materialized view (RLS never applies to it) |
| `P31` | exact privileges of `flower_app`, `flower_platform`, `flower_migrate`, PUBLIC on each view | SE1 expects `flower_platform` = `SELECT` only; `flower_app` and PUBLIC nothing |
| **`P40`** | **`audit_log` parent and every partition: effective privileges** | **FAIL = `flower_app` / `flower_platform` hold `UPDATE` / `DELETE` / `TRUNCATE` (the AL1 finding)**; WARN = `REFERENCES` / `TRIGGER`, or the DDL role holds `UPDATE` / `DELETE` / `TRUNCATE` |
| `P41` | AL1 guards on the parent **and every partition**: an `ENABLE ALWAYS` row guard and `TRUNCATE` guard | FAIL = a partition lacks a guard (also how a **new partition** missing its guard shows up) |
| `P42` | `audit_log` / `login_security_event` RLS enabled **and forced**, with a policy | FAIL = the tenant boundary on the table itself is open |
| `P43` | tenant tables (a `tenantId` column) **without** FORCE RLS | INFO list for the reviewer (platform-global tables are expected exemptions) |
| `P50` | **default privileges**: what a future table / view / partition created by each role inherits | WARN = future objects get `UPDATE` / `DELETE` / `TRUNCATE` for the app / platform roles (which default applies depends on **who runs the next migration**) |

## What each environment looks like (measured on disposable PostgreSQL 17 — `packages/db/test/phase4-security-preflight.integration.test.ts`)

| Posture | `P20` | `P30` security_event | `P40`/`P41` audit_log |
|---|---|---|---|
| Superuser-owned, nothing applied (the test harness; the **staging compose**, whose `migrate` service connects as `postgres`) | WARN | **FAIL** | **FAIL** |
| Owned by `flower_migrate`, nothing applied (what the migration comments describe for production) | PASS | WARN (isolated only by the owner) | **FAIL** |
| AL1 applied | unchanged | unchanged | PASS |
| SE1 applied | unchanged | **PASS** | unchanged |
| AL1 + SE1, superuser-owned | **WARN (the residual is still reported)** | PASS | PASS |
| AL1 + SE1, owned by `flower_migrate` | PASS | PASS | PASS |

The script **never reports an applied remediation as having fixed ownership**: superuser ownership stays a `P20` WARN after AL1 + SE1.

## Limits (read before relying on it)

- It **infers** the migration role from ownership and the session role; it cannot see which role ran past migrations. Run it with the migration connection string and compare `P21` with `P20`.
- It cannot detect owner / superuser DDL **after the fact** (a disabled trigger shows as a `P41` FAIL only while it is disabled).
- It reads the catalog **as of now**: run it again after any migration, and before promoting AL1 or SE1.
- A `FAIL` or `WARN` is a finding to be explained, not an automatic stop: `docs/decisions/AL1-SE1-INDEPENDENT-REVIEW-HANDOFF.md` maps each check to a release blocker or an optional hardening item.
