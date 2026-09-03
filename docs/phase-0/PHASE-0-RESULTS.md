# Phase 0 — Results

> Written at Task 0.13. Records what was built, the verification output, and the
> RLS-spike verdict. Companion to
> [`PHASE-0-PLAN.md`](PHASE-0-PLAN.md) and [`PHASE-0-CHECKLIST.md`](PHASE-0-CHECKLIST.md).
>
> **`phase-0-complete` is NOT tagged until the GitHub push + CI run are green.**
> See [§ Outstanding](#-outstanding-before-phase-0-complete).

Date: 2026-09-03 · Executor: Claude Sonnet 5 (Claude Code) · Approved plan: artifact
v0.4 §P0.

---

## 1. Environment (actual versions)

| Component                 | Version                                                             | Notes                                                                   |
| ------------------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| OS                        | Windows 10 Pro 10.0.19045.7663 (22H2) x64                           | dev box; CI = `ubuntu-latest`                                           |
| Shell                     | Git Bash (MINGW64) + PowerShell 5.1                                 |                                                                         |
| WSL                       | 2.7.12.0, kernel 6.18.33.2-2                                        | distro `docker-desktop`                                                 |
| Docker Desktop            | 4.89.0 (238018)                                                     |                                                                         |
| Docker Engine             | 29.7.2 (linux/amd64), API 1.55                                      | context `desktop-linux`; overlayfs                                      |
| Docker Compose            | v5.5.0                                                              |                                                                         |
| Docker VM                 | 4 vCPU / 3.77 GiB RAM                                               | tight for full stack + clamav; recorded for CI runner sizing            |
| Node.js                   | 24.20.0 (`.nvmrc`)                                                  | `engines >=24.20.0 <25`                                                 |
| pnpm                      | **10.34.5** — pinned via `packageManager` + sha512, `.npmrc` strict | plan text said "9.x" — deliberate; see ADR-0013                         |
| TypeScript                | 5.9.3                                                               | not 7.0.2 — `@typescript-eslint` / NestJS decorator toolchain; ADR-0013 |
| Turborepo                 | 2.10.12                                                             |                                                                         |
| Prisma / `@prisma/client` | **7.10.0** (not 8.0-rc)                                             | Prisma 7: no `datasource.url` in schema, `pg` driver adapter; ADR-0013  |
| NestJS                    | 12.0.1                                                              | Fastify 5.12.1 adapter                                                  |
| Next.js / React           | 16.3.4 / 19.2.8                                                     | Turbopack default; SWC native                                           |
| ESLint                    | 10.9.1 (flat)                                                       | `eslint-plugin-boundaries` 7.2.0 (v7 `dependencies` API)                |
| Vitest                    | 4.1.11                                                              |                                                                         |
| Testcontainers            | 12.1.0 (+ postgresql / redis / minio modules)                       |                                                                         |
| git                       | 2.55.0.windows.5                                                    | credential helper `manager`                                             |

**Environment prerequisite (Windows):** the **Microsoft Visual C++ 2015–2022 x64
Redistributable** was missing (`api-ms-win-crt-*` / `vcruntime140.dll` absent) —
without it no MSVC-linked native binary loads (Turborepo, Next SWC, Prisma
engine). Installed 2026-09-03; recorded in ADR-0013.

---

## 2. What was built (per task)

| Task     | Commit                             | Deliverable                                                                                                                                                                                                                                                                                                                                                                     |
| -------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| docs     | `d2db275` (tag `spec-frozen-v0.4`) | 6 architecture docs, DECISION-LOG + ADR-0001…0013, 5 conventions docs, PHASE-0-PLAN/CHECKLIST, CLAUDE.md, README, LICENSE, `.gitattributes` (LF)                                                                                                                                                                                                                                |
| **0.1**  | `5c00dfc`                          | `git init` on `main`; pnpm workspace + Turborepo; `tsconfig.base.json`; `.npmrc`/`.nvmrc`/`.editorconfig`/`.prettierrc`; pnpm pinned + strict                                                                                                                                                                                                                                   |
| **0.2**  | `48051c6`                          | `@flower/config` — ESLint flat-config factory; `eslint-plugin-boundaries` v7 dependency-policy model; 3 custom rules (`no-scope-from-request`, `no-raw-prisma-in-scoped-modules`, `route-must-declare-permission`); tsconfig bases; Tailwind preset; Prettier config. 29 RuleTester tests + negative fixture.                                                                   |
| **0.3**  | `0bf6fd9`                          | 9 pure packages. `@flower/money` (24 tests — minor units + exponent, 2/3-dp rounding, VAT %, `allocate()` residual). `@flower/uom` (18 tests — exact `NUMERIC(18,4)` quantities, integer-ratio conversions, per-unit decimal rules). shared-types (zod), permissions (§9 registry), i18n, api-client, realtime-client (EventReducer), ui (tokens + Button), testing (skeleton). |
| **0.4**  | `8bffc43`                          | `apps/api` — NestJS 12 + Fastify 5, zod env config, pino + correlation id, one global error envelope, `@Public()`/`@RequirePermission()` decorators, OpenAPI scaffold + Swagger UI, `/healthz` + `/readyz`, graceful shutdown. 6 tests.                                                                                                                                         |
| **0.5**  | `7034b12`                          | `@flower/db` — Prisma 7 baseline (`prisma7.config.ts`, no domain tables, `app_meta` infra model), baseline migration, `createPrismaClient()` over `@prisma/adapter-pg`, seed skeleton. 4 Testcontainers tests.                                                                                                                                                                  |
| **0.6**  | `381a73a`                          | **RLS + PgBouncer spike (the HARD gate).** See §3.                                                                                                                                                                                                                                                                                                                              |
| **0.7**  | `387716b`                          | `apps/worker` (BullMQ queue set), `apps/scheduler` (repeatable-job registrar + heartbeat), `apps/realtime` (Fastify WS gateway — connect/ack/echo/close, co-deployable per ADR-0009). NEW `@flower/service-runtime` (env/logger/Redis/health plumbing, no business logic — ADR-0013). 12 tests.                                                                                 |
| **0.8**  | `0cc21a6`                          | 4 Next.js 16 apps (App Router, Turbopack, `output: standalone`, Tailwind v4). Each renders `API: healthy` via `@flower/api-client`. `pos-pwa`: manifest + shell-precache SW + registrar + PNG icons → installable.                                                                                                                                                              |
| **0.9**  | `f450470` (tag `phase-0-infra`)    | `docker-compose.yml` (postgres 17, redis 7, minio + bucket bootstrap, clamav, mailpit — all healthchecked; project `flower-saas`, `flower*` volumes). `tooling/scripts/` (dev-up, wait-healthy, db-reset, seed). Wired the real `/readyz` migrations check.                                                                                                                     |
| **0.10** | `6be1340`                          | `.github/workflows/ci.yml` — `verify` (typecheck·lint·test·build·negative-test) + `security` (Syft SBOM · osv-scanner · gitleaks · Trivy config+fs). `infra/docker/{node-service,web}.Dockerfile` (multi-stage, non-root). `pnpm.overrides` fixing 3 transitive Prisma-CLI vulns.                                                                                               |
| **0.11** | `eee97d0`                          | `@flower/testing` — `startTestStack()` (Testcontainers pg+redis+minio), `withTenantContext()` (interactive txn + `SET LOCAL`), `runIsolationProbes()` / `assertNoLeaks()` / `crossBoundaryCases()`, concurrency helpers. 12 tests (8 pure + 4 real-container self-test).                                                                                                        |
| **0.12** | `150b089`                          | lefthook hooks: pre-commit (prettier `--check` + eslint on staged), commit-msg (commitlint / Conventional Commits), pre-push (typecheck). Both negative tests demonstrated.                                                                                                                                                                                                     |
| **0.13** | _this commit_                      | full verification pass + this document.                                                                                                                                                                                                                                                                                                                                         |

### Modules / packages created

```
apps/        api · worker · scheduler · realtime · super-admin-web · owner-web · pos-pwa · customer-web
packages/    config · db · service-runtime · shared-types · permissions · api-client ·
             realtime-client · money · uom · i18n · ui · testing
tooling/     scripts/ (dev-up, wait-healthy, db-reset, seed, check-ws) · spikes/rls/
infra/       docker/ (node-service.Dockerfile, web.Dockerfile) · terraform/ (placeholder)
docs/        architecture · decisions · conventions · phase-0
```

No domain/business modules — `apps/api/src/modules/` is empty (CLAUDE.md rule 4).

---

## 3. RLS spike results & ADR-0010 verdict

**VERDICT: `GO`. No Kysely fallback.** Full detail in
[`../decisions/ADR-0010.md`](../decisions/ADR-0010.md).

Real Docker stack (`tooling/spikes/rls/docker-compose.yml`, isolated project
`flower-rls-spike`): `postgres:17` + `edoburu/pgbouncer` in **transaction-pool
(:55533) AND session-pool (:55534)** + a direct connection (:55532). `spike_app`
role is `NOSUPERUSER NOBYPASSRLS`; RLS `ENABLE + FORCE` on both tables; policy
keys off `nullif(current_setting('app.tenant_id', true), '')::uuid` → an unset or
empty GUC yields **zero rows** (fails closed).

Candidate pattern: a Prisma **interactive transaction** that first runs
`SELECT set_config('app.tenant_id', $1, true)` (`SET LOCAL`, parameter-bound;
tenant id UUID-validated before it reaches SQL).

**21 assertions × 3 endpoints — all pass:**

| Check                                                     | direct | pgb-transaction | pgb-session |
| --------------------------------------------------------- | :----: | :-------------: | :---------: |
| Scoped read sees only the acting tenant                   |   ✅   |       ✅        |     ✅      |
| Cannot fetch the other tenant's row by primary key        |   ✅   |       ✅        |     ✅      |
| Unscoped query (no GUC) → 0 rows (no error, no leak)      |   ✅   |       ✅        |     ✅      |
| No GUC bleed onto a pooled connection after a scoped txn  |   ✅   |       ✅        |     ✅      |
| `WITH CHECK` blocks a cross-tenant INSERT                 |   ✅   |       ✅        |     ✅      |
| 20× interleaved concurrent A‖B transactions stay isolated |   ✅   |       ✅        |     ✅      |

Latency: the scoped wrapper adds **~3 ms** (`BEGIN` / `set_config` / `COMMIT`)
over a bare query, consistent across all modes (direct p50 4.28 ms; pgb-txn 4.49;
pgb-session 4.17).

**Production guidance:** use PgBouncer **transaction-pool** mode; session mode needs
`pool_size ≥ app-pool + concurrency`. App DB role `NOSUPERUSER NOBYPASSRLS`;
migrations run as a separate role. Phase 1 wraps this in `ScopedRepository`; the
0.2 lint rules + the build-blocking probe suite enforce it.

`/security-review` could not be auto-run (empty GitHub remote → no `origin/HEAD`
to diff); a manual review of the spike is documented in ADR-0010. The full
automated security-review + cross-tenant probe suite run in Phase 1 CI against
real endpoints.

---

## 4. Verification output (§E)

Commands run 2026-09-03 (dev box). CI equivalents in `.github/workflows/ci.yml`.

| #   | Check                                                                                          | Result                                                                                                                                  |
| --- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `pnpm install --frozen-lockfile`                                                               | ✅ "Lockfile is up to date … Already up to date"                                                                                        |
| 2   | `pnpm -w typecheck`                                                                            | ✅ **29 tasks successful**                                                                                                              |
| 3   | `pnpm -w lint` (boundary + no-raw-prisma + route-permission + no-scope-from-request)           | ✅ **29 tasks successful**                                                                                                              |
| 4   | `pnpm -w build`                                                                                | ✅ **20 tasks successful** (all apps + packages; 4 Next apps "Compiled successfully")                                                   |
| 5   | `docker compose up` from clean → `wait-healthy.sh`                                             | ✅ **5 infra services healthy in ~30–45 s (< 60 s)** — postgres, redis, minio, clamav, mailpit                                          |
| 5b  | MinIO buckets                                                                                  | ✅ `flower-private`, `flower-quarantine`, `flower-public` created                                                                       |
| 6   | `pnpm --filter @flower/db migrate:deploy` + `pnpm seed`                                        | ✅ migration applied; `seed ok — app_meta has 1 row(s)`                                                                                 |
| 7   | `curl /healthz` (api)                                                                          | ✅ `200 {"status":"ok"}`                                                                                                                |
| 7   | `curl /readyz` (api, full stack up)                                                            | ✅ `200 {"status":"ok","checks":{"db":"ok","redis":"ok","storage":"ok","migrations":"ok"}}`                                             |
| 7   | `curl /healthz` (realtime)                                                                     | ✅ `200 {"status":"ok","role":"realtime"}`                                                                                              |
| 7   | `node tooling/scripts/check-ws.mjs`                                                            | ✅ `connect → ack → echo → close (code 1000)`                                                                                           |
| 8   | 4 web apps (`:3100 / :3200 / :3300 / :3400`)                                                   | ✅ each renders **`API: healthy`**                                                                                                      |
| 9   | pos-pwa `/manifest.webmanifest` / `/sw.js` / icons                                             | ✅ `200 application/manifest+json` / `200` / `200`                                                                                      |
| 10  | `pnpm -w test` (full — incl. Testcontainers + PgBouncer)                                       | ✅ **29 tasks successful**                                                                                                              |
| 11  | `@flower/config test:negative` (boundary + scope violation)                                    | ✅ "NEGATIVE TEST PASSED"                                                                                                               |
| 12  | money AED 2dp / KWD 3dp rounding + split residual                                              | ✅ 24 tests                                                                                                                             |
| 12  | uom fractional (1.5 m) + pack (carton→12)                                                      | ✅ 18 tests                                                                                                                             |
| 13  | db: fresh PG → `migrate deploy` → baseline asserted                                            | ✅ 4 Testcontainers tests                                                                                                               |
| 14  | **RLS spike** — tenant B blocked under session- AND transaction-pool; ADR-0010 verdict written | ✅ 21 assertions × 3 endpoints; verdict **GO**                                                                                          |
| 15  | probe harness spins a stack up + down; self-test                                               | ✅ `@flower/testing` 4 real-container tests                                                                                             |
| 16  | negative test: non-Conventional commit message blocked                                         | ✅ commitlint "type may not be empty"                                                                                                   |
| 16  | negative test: unformatted staged file blocked                                                 | ✅ prettier "Code style issues found" + eslint                                                                                          |
| 17  | `docs/` complete                                                                               | ✅ 6 architecture + 5 conventions + DECISION-LOG + ADR-0001…0013 + PHASE-0-PLAN/CHECKLIST/RESULTS + CLAUDE.md                           |
| 18  | Isolation from Salon SaaS                                                                      | ✅ no Salon files tracked; compose project `flower-saas`; `flower*` volumes; only namespaced containers used; no broad `docker` cleanup |
| 19  | negative test: route with no `@RequirePermission`/`@Public` fails lint                         | ✅ `route-must-declare-permission` (RuleTester: `list()` with `@Get()` only → error)                                                    |
| 20  | negative test: reading `tenant_id` from a request fails lint                                   | ✅ `no-scope-from-request` (RuleTester + fixture)                                                                                       |

**Test suite totals (per `pnpm -w test`, 29 turbo tasks, all green):**

| package                                       |     tests | package                       |           tests |
| --------------------------------------------- | --------: | ----------------------------- | --------------: |
| `@flower/config` (+ negative fixture)         |        29 | `spike-rls` (RLS/PgBouncer)   |              21 |
| `@flower/money`                               |        24 | `@flower/uom`                 |              18 |
| `@flower/testing` (8 pure + 4 real-container) |        12 | `@flower/realtime-client`     |               6 |
| `@flower/api`                                 |         6 | `@flower/permissions`         |               5 |
| `@flower/service-runtime`                     |         5 | `@flower/db` (Testcontainers) |               4 |
| `@flower/i18n`                                |         4 | `@flower/api-client`          |               3 |
| `@flower/shared-types`                        |         3 | `@flower/ui` (SSR)            |               3 |
| `@flower/realtime`                            |         3 | `@flower/scheduler`           |               2 |
| `@flower/worker`                              |         2 | 4 web apps                    | passWithNoTests |
| **Total**                                     | **≈ 150** |                               |                 |

### CI gates — demonstrated locally

| Gate                                      | Local demonstration                                                                                       |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| install / typecheck / lint / test / build | see rows 1–4, 10 above                                                                                    |
| `@flower/config test:negative`            | "NEGATIVE TEST PASSED"                                                                                    |
| gitleaks (git mode, 10 commits)           | "no leaks found"                                                                                          |
| Trivy — config scan `infra/docker`        | **0 misconfigurations** on both Dockerfiles                                                               |
| osv-scanner — `pnpm-lock.yaml`            | **"No issues found"** (after `pnpm.overrides` for mysql2 / deepmerge-ts)                                  |
| SBOM (Syft)                               | CycloneDX — action pinned; not run locally (pnpm-lock understood by Syft, not `@cyclonedx/cyclonedx-npm`) |

---

## 5. Git

- **Branch:** `main`. **Commits:** 13 (spec-frozen + 0.1…0.12 + this).
- **Tags (annotated):** `spec-frozen-v0.4`, `phase-0-infra`.
  **`phase-0-ci` and `phase-0-complete` are NOT yet placed** — see §Outstanding.
- **Remote:** `origin = https://github.com/horizone-dev/flower-saas.git` — **empty,
  not yet pushed** (auth pending).
- Every commit passed the lefthook gates; every commit carries the
  `Co-Authored-By` + `Claude-Session` trailers.
- No history rewrite, no force-push. No Salon SaaS files.

## 6. Docker services (dev)

`docker compose` project **`flower-saas`**:
`flower-postgres` (17, :5432) · `flower-redis` (7, :6379) · `flower-minio`
(:9000/:9001) + `flower-minio-init` (one-shot) · `flower-clamav` (:3310) ·
`flower-mailpit` (:1025/:8025). Volumes `flower-{pg,redis,minio,clamav,mailpit}-data`.
Spike-only: `tooling/spikes/rls/docker-compose.yml` (project `flower-rls-spike`).

## 7. Security / isolation verification

- **RLS spike (0.6):** GO — see §3.
- **Lint-enforced isolation (0.2):** `no-scope-from-request`,
  `no-raw-prisma-in-scoped-modules`, `route-must-declare-permission` — RuleTester +
  a build-blocking negative fixture (`boundaries/dependencies` + scope violation).
- **Probe harness (0.11):** `runIsolationProbes` / `assertNoLeaks` +
  `withTenantContext` proven against real containers.
- **Secrets:** gitleaks clean over all history; no `.env` committed
  (`.env.example` only); pino redaction path list in `apps/api` + service-runtime.
- **Dependencies:** osv-scanner clean; Trivy config clean.
- No secret-management permission key exists in `@flower/permissions` (asserted by
  test) — the capability does not exist in the tenant realm (CLAUDE.md 26).

## 8. Known issues / deferred items

- **`output: standalone` + `public/`** — Next does not copy `public/` or
  `.next/static` into the standalone bundle; `infra/docker/web.Dockerfile` copies
  them explicitly. A local `next start` warns; use `node .next/standalone/.../server.js`.
- **Graceful SIGTERM** — handlers are registered and correct for Linux/prod;
  Windows has no SIGTERM, so local shutdown is a hard kill. Verified structurally.
- **Docker VM RAM (3.77 GiB)** — the full compose stack + clamav + a Testcontainers
  suite is tight. Running _all_ Docker-heavy test tasks at once with `turbo … --force`
  can contend; CI pins `--concurrency`.
- **`@types/pg`** pinned to `8.23.1` (registry `latest`); `@prisma/client-runtime-utils`
  added as an explicit `@flower/db` dep so the generated client resolves under
  pnpm isolation.
- Real protocol-level `/readyz` checks for redis/storage (currently TCP probes),
  the outbox dispatcher, `ScopedRepository`, the guard pipeline, and real seed
  fixtures are **Phase 1+**, by design.

---

## ⛔ Outstanding before `phase-0-complete`

Per the owner's instruction, Phase 0 is **not** declared complete until:

1. **GitHub push** — `git push -u origin main && git push origin --tags`
   (blocked on interactive GitHub auth on the dev box).
2. **CI green on GitHub Actions** — the `verify` + `security` jobs pass on a fresh
   branch / the pushed `main`.

When both are green: place `phase-0-ci` (at `6be1340`) and `phase-0-complete` (at
the 0.13 commit, referencing this file), then STOP for owner approval before
Phase 1.
