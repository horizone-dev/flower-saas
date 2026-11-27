# Staging preflight runbook — STAGING ONLY

**STAGING ONLY. Do not run anything in this runbook against production.** Production is a separate step that starts only after the staging report has been reviewed. **Status: PREPARED — NOT APPROVED**: you may start only after the owner has named you as the operator and authorized this read-only run. This runbook records no approval, and nothing in it changes a database.

What you run is `PREFLIGHT.sql`: one read-only `SELECT` over the PostgreSQL **catalogs** (no table rows). What leaves your environment is one redacted **report**.

## 1. Before you start — prerequisites (all must be true)

| # | You need | If missing |
|---|---|---|
| 1 | The owner's authorization naming you as operator for the **staging** run | stop |
| 2 | The pack verified. The folder you were sent holds **six** files: the four operator files (`PREFLIGHT.sql`, `preflight-report.mjs`, `README.md`, this runbook) **plus** `share-pack.mjs` and `SHARE-MANIFEST.json`. `node share-pack.mjs hashes` must print the two sha256 values the owner sent you **through a separate channel**, and `node share-pack.mjs verify . operator` must print `ALL FILES VERIFIED` | stop; do not use the files |
| 3 | `psql` on a machine that reaches staging by your normal route (VPN / bastion). Tested with `psql` 17; any recent client is expected to work | install or use your normal DBA workstation |
| 4 | **Node 24** (the report tool was tested on 24.20.0) on the same machine — the raw capture must never leave it | install Node, or stop |
| 5 | A staging login with `CONNECT` on the database and `USAGE` on schema `public` (both are defaults). **Nothing else**: no superuser, no table privilege. Your own admin / read-only login is fine; do **not** use `flower_app` / `flower_platform` | ask your DBA for a read-only login |
| 6 | If you are authorized to use it: the **migration** login (answers check `P21`). If you are not, say so in your hand-off | the reviewer will mark `P21` UNKNOWN |
| 7 | Your connection details in a `pg_service.conf` entry (host, port, dbname, user — **no password**) and the password in `~/.pgpass` or `PGPASSFILE`, both **outside** this pack | see §2 |

## 2. Commands (bash; in the folder that holds the pack)

```bash
# A. verify what you received (offline; prints OK / MISSING / MISMATCH per file)
node share-pack.mjs verify . operator

# B. confirm the target is STAGING (the output stays on your screen; send it to nobody)
PGSERVICE=<your-staging-service> psql -X -c '\conninfo'

# C. capture #1 - the MIGRATION login (answers P21). Read-only; no connection string and no password on the command line
PGSERVICE=<your-staging-migrate-service> PGOPTIONS='-c default_transaction_read_only=on' \
psql -X -q -v ON_ERROR_STOP=1 -A -F "$(printf '\t')" --pset footer=off -f PREFLIGHT.sql > captured-migrate.tsv

# D. capture #2 - an ordinary read-only login
PGSERVICE=<your-staging-service> PGOPTIONS='-c default_transaction_read_only=on' \
psql -X -q -v ON_ERROR_STOP=1 -A -F "$(printf '\t')" --pset footer=off -f PREFLIGHT.sql > captured-ordinary.tsv

# E. build the two redacted reports (offline; writes only the --out file)
node preflight-report.mjs captured-migrate.tsv  --env staging --script PREFLIGHT.sql --out preflight-staging-migrate.md
node preflight-report.mjs captured-ordinary.tsv --env staging --script PREFLIGHT.sql --out preflight-staging-ordinary.md
```

`<your-…-service>` are names of entries in **your** `pg_service.conf` (default `~/.pg_service.conf`); they are placeholders here — this runbook contains no host, user or password. Steps B–D were proved on real `psql` with a service entry that holds no password (`phase4-security-preflight-operator.integration.test.ts`).

## 3. What to send back — and what never leaves

- **Send** `preflight-staging-migrate.md` and `preflight-staging-ordinary.md` to the independent reviewer, **unedited**. Each names the sha256 of `PREFLIGHT.sql` it was built from.
- **Never send** `captured-*.tsv`, your `pg_service.conf`, `.pgpass`, the `\conninfo` output, or any screenshot of them. **Never** edit a capture or a report.
- If `preflight-report.mjs` prints **REFUSED**, it found content that must not leave (a credential, address, tenant id…); nothing was written. Fix it at the source and re-run — do not hand-edit and forward.

## 4. If something goes wrong

| You see | Meaning | Do |
|---|---|---|
| `permission denied for schema public` | your login lacks `USAGE` on `public` | ask for a login that has it; the capture is empty |
| `permission denied for database` | your login lacks `CONNECT` | same |
| report tool: `UNPARSEABLE` | the capture is empty or `psql` failed | read the `psql` error above; re-run |
| report tool: `REFUSED` | the capture holds something that must not leave | stop; tell the reviewer **that** (not the content) |
| the report lists `UNKNOWN` rows | a check produced no row (an object may not exist) | send it as is; the reviewer decides |
| `\conninfo` shows a host that is **not** staging | wrong target | **stop**; do not run C or D |

## 5. Operator checklist (staging)

- [ ] The owner has named me and authorized the read-only STAGING run.
- [ ] `share-pack.mjs verify` says ALL FILES VERIFIED; the two separate-channel hashes match.
- [ ] `\conninfo` confirms the target is staging.
- [ ] Capture #1 (migration login) and #2 (ordinary login) done with the read-only command above.
- [ ] Two reports built; neither was REFUSED.
- [ ] I sent **only** the two reports; captures, service file and `.pgpass` stayed with me.

**Not in scope here:** production, any migration, any role or permission change, any approval. If you are asked to do one of them under this runbook, stop and escalate.
