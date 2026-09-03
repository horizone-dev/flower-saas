# Phase 0 execution plan (approved)

> Frozen from architecture v0.4 §P0. Phase 0 writes **no domain/business code** — it
> is repo scaffolding, infra, CI and the RLS spike. Execution order and stop points
> are non-negotiable (CLAUDE.md §11). One task at a time; verify after each; commit
> only green; STOP at `phase-0-complete` for owner approval before Phase 1.

## A · Docs & files to create (steps 1–2 — freeze the spec, write CLAUDE.md)

The approved architecture (v0.4) is exported to Markdown and split for
maintainability. Everything under `docs/` is versioned and is the specification of
record.

| path                                    | content                                                                                          |
| --------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `CLAUDE.md`                             | permanent non-negotiable project rules — loaded every session                                    |
| `README.md`                             | what the project is, prerequisites, one-command dev start, links into `docs/`                    |
| `docs/architecture/ARCHITECTURE.md`     | the frozen approved architecture v0.4                                                            |
| `docs/architecture/DOMAIN-MODEL.md`     | consolidated entities + relationships (§52 + financial concepts)                                 |
| `docs/architecture/ROADMAP.md`          | the 11-phase roadmap with per-phase exit criteria                                                |
| `docs/architecture/SECURITY.md`         | request pipeline, tenant + branch isolation, RLS, probe suites, audit, secrets                   |
| `docs/architecture/GLOSSARY.md`         | canonical definitions                                                                            |
| `docs/architecture/CHANGELOG.md`        | spec version history v0.1 → v0.4, dated                                                          |
| `docs/decisions/DECISION-LOG.md`        | Z-1…Z-14, ZF-1…ZF-9 — statement, status, resolution, date; append-only                           |
| `docs/decisions/ADR-0001 … ADR-0013.md` | one ADR per load-bearing choice (0013 = toolchain deviation)                                     |
| `docs/conventions/CODING-STANDARDS.md`  | TS strictness, naming, module boundaries, error handling                                         |
| `docs/conventions/API-CONVENTIONS.md`   | REST `/v1`, versioning, error envelope, pagination, `Idempotency-Key`, auth headers              |
| `docs/conventions/DB-CONVENTIONS.md`    | UUID v7, `tenant_id` everywhere, index order, partitioning, expand/contract, money & UOM columns |
| `docs/conventions/TESTING-STRATEGY.md`  | unit / integration / e2e / probe / concurrency / financial suites; local-first, no silent skips  |
| `docs/conventions/GIT-WORKFLOW.md`      | trunk-based, Conventional Commits, checkpoint tags, no history rewrite                           |
| `docs/phase-0/PHASE-0-PLAN.md`          | this plan                                                                                        |
| `docs/phase-0/PHASE-0-CHECKLIST.md`     | the per-task verification checklist (§E)                                                         |
| `docs/phase-0/PHASE-0-RESULTS.md`       | written at the end: what was built, verification output, the RLS-spike verdict                   |

**ADRs:** 0001 modular monolith · 0002 four apps / no Staff App · 0003 branch is the
operational boundary · 0004 app-layer scoping + RLS + probe suites · 0005
double-entry GL as a projection · 0006 money as minor units + exponent · 0007
provider adapter ports + Super-Admin-only secrets · 0008 online-only
financial/inventory sales for v1 · 0009 realtime via outbox → Redis Streams →
gateway · 0010 Prisma + RLS (verdict from the Phase 0 spike) · 0011 UAE primary
region, region-portable · 0012 e-invoicing country adapters + KSA gating · 0013
toolchain & version pins.

## B · Final monorepo directory structure (step 4)

pnpm workspaces + Turborepo. Business logic lives only in `apps/api` (imported by
`worker`/`scheduler`); packages hold contracts, constants and pure utilities;
ESLint boundary rules enforce it. Phase 0 creates the skeleton — module directories
are added per phase.

```
flower-saas/                 package.json, pnpm-workspace.yaml, turbo.json,
                             tsconfig.base.json, .nvmrc (Node 24), .editorconfig,
                             .gitignore, .npmrc, .env.example, docker-compose.yml,
                             lefthook.yml, commitlint.config.cjs, CLAUDE.md,
                             README.md, LICENSE
.github/workflows/ci.yml     the CI pipeline
docs/                        the specification of record (section A)
apps/api/                    NestJS + Fastify — src/main.ts, app.module.ts, config/,
                             common/ (request-context, guard pipeline, error model,
                             idempotency, logging, pagination), health/, modules/
                             (empty), test/, Dockerfile
apps/worker/                 NestJS bootstrap → BullMQ processors; imports apps/api
                             domain modules; Dockerfile
apps/scheduler/              repeatable-job registrar (singleton); Dockerfile
apps/realtime/               WebSocket / SSE gateway; Redis Streams consumer;
                             Dockerfile  (co-deployable with api early — ADR-0009)
apps/super-admin-web/        Next.js (App Router) — separate deployment
apps/owner-web/              Next.js
apps/pos-pwa/                Next.js PWA — manifest + service worker (shell precache
                             only in Phase 0)
apps/customer-web/           Next.js — storefront + AI chat widget
packages/config/             ESLint flat config + eslint-plugin-boundaries + custom
                             rules (no-raw-prisma-in-scoped-modules,
                             route-must-declare-permission, no-scope-from-request),
                             tsconfig bases, Tailwind preset, Prettier config
packages/db/                 Prisma schema + generated client + migrations + seed;
                             shared by api, worker, scheduler
packages/shared-types/       DTOs, enums, zod schemas — no logic
packages/permissions/        permission-key constants + types
packages/api-client/         typed REST client generated from the OpenAPI spec
packages/realtime-client/    subscribe / resume-from-seq / dedup / backoff
packages/money/              currencies + exponents, minor-unit math, rounding — pure
packages/uom/                unit families + conversion, fractional-safe — pure
packages/i18n/               locale + RTL helpers, message catalogs, CLDR wiring
packages/ui/                 shared React design system + feature components
packages/testing/            Testcontainers bootstrap, tenant + branch probe harness,
                             concurrency-test utilities, fixtures
infra/docker/                Dockerfiles, compose overrides
infra/terraform/             empty placeholder (later phases)
tooling/scripts/             dev-up.sh, wait-healthy.sh, db-reset.sh, seed.sh,
                             codegen.sh
tooling/spikes/rls/          the Phase 0 RLS + connection-pooling spike
```

**Refinement vs the architecture doc:** the Prisma schema lives in `packages/db`
(not `infra/db`) so `api`, `worker` and `scheduler` share one generated client and
one migration history.

## C · Phase 0 task breakdown (in execution order — steps 7–9)

| #        | Task                                                                                                                                                                                                                                                                                                                 | Done when                                                                                                                                |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| **0.1**  | Repo init: `git init` on `main`, `.gitignore`, `.editorconfig`, `.nvmrc`, `LICENSE`, root `README`, pnpm workspace, Turborepo, `tsconfig.base`, Prettier                                                                                                                                                             | `pnpm install` succeeds; `turbo run` resolves an empty graph                                                                             |
| **0.2**  | `packages/config`: ESLint flat config + boundary rules + the three custom rules (stubbed with tests); tsconfig bases; Tailwind preset; Prettier config                                                                                                                                                               | `pnpm lint` runs; a deliberate boundary-violation fixture fails lint (negative test)                                                     |
| **0.3**  | Pure packages scaffolded: `shared-types`, `permissions`, `money`, `uom`, `i18n`, `api-client`, `realtime-client`, `ui`, `testing` — each with build + one test. `money` & `uom` get real first suites (AED 2dp / KWD 3dp rounding; 1.5 m ribbon; carton→piece)                                                       | `pnpm test` green; money & uom suites meaningful                                                                                         |
| **0.4**  | `apps/api` skeleton: NestJS + Fastify, zod-validated env config, pino + correlation id, global error envelope, OpenAPI scaffold, `/healthz` + `/readyz`, graceful shutdown                                                                                                                                           | `api` boots; `/healthz` → 200; `/readyz` reports db/redis/storage/migrations                                                             |
| **0.5**  | `packages/db`: Prisma init, baseline empty schema, `prisma migrate` wired, client exported, seed skeleton, a Testcontainers migration test                                                                                                                                                                           | fresh PG → `migrate deploy` → baseline asserted by the test                                                                              |
| **0.6**  | **RLS + connection-pooling spike** (`tooling/spikes/rls`): 2 tenant-scoped tables + RLS policy; a Prisma client extension issuing `SET LOCAL app.tenant_id` in interactive transactions; tested under PgBouncer transaction-pool **and** session-pool; measure isolation, correctness, connection behaviour, latency | ADR-0010 written with the verdict: _go_ / _go + Kysely for scope-critical reads_; a follow-up task is appended if the fallback is chosen |
| **0.7**  | `apps/worker`, `apps/scheduler`, `apps/realtime` entry stubs: each boots, connects to Redis, reports healthy; `realtime` accepts a WS connection + ack (no topics)                                                                                                                                                   | all three start clean; WS connect/ack/close works                                                                                        |
| **0.8**  | Four Next.js app skeletons: App Router, Tailwind via the shared preset, `packages/ui` shell (theme tokens + Button), one page each calling `/healthz` via `api-client` and rendering status; `pos-pwa` manifest + shell-precache SW                                                                                  | each app builds + dev-runs + shows "API: healthy"; POS PWA is installable                                                                |
| **0.9**  | `docker-compose.yml`: postgres 17, redis 7, minio + bucket bootstrap, clamav, mailpit — healthchecks, volumes, `.env.example`; `tooling/scripts` (`dev-up`, `wait-healthy`, `db-reset`, `seed`)                                                                                                                      | `docker compose up` from clean → all services healthy < 60s                                                                              |
| **0.10** | CI: `.github/workflows/ci.yml` — install (frozen lockfile), typecheck, lint, unit, `packages/db` migration test, build all, SBOM, dependency audit (osv-scanner), Trivy on Dockerfiles, gitleaks                                                                                                                     | CI green on a fresh branch; each gate individually demonstrated                                                                          |
| **0.11** | `packages/testing` harness: Testcontainers bootstrap (pg+redis+minio), `withTenantContext`, the tenant + branch probe-suite skeleton (self-test until endpoints exist)                                                                                                                                               | harness spins up + tears down a stack; self-test green                                                                                   |
| **0.12** | Pre-commit / pre-push hooks (lefthook): format + lint-staged + commitlint (Conventional Commits) + typecheck-on-push                                                                                                                                                                                                 | a bad commit message and an unformatted file are both blocked (negative tests)                                                           |
| **0.13** | Phase 0 verification pass: run the full checklist (§E / PHASE-0-CHECKLIST.md), fix anything red, write `PHASE-0-RESULTS.md`                                                                                                                                                                                          | every checklist item green; results doc committed                                                                                        |

## D · Local services & ports

**Infrastructure (docker compose — project name `flower-saas`):**

| service       | port        | purpose                                                                           |
| ------------- | ----------- | --------------------------------------------------------------------------------- |
| `postgres:17` | 5432        | primary DB                                                                        |
| `redis:7`     | 6379        | cache · sessions · BullMQ · streams · pub/sub                                     |
| `minio`       | 9000 / 9001 | S3 API / console — buckets `flower-private`, `flower-quarantine`, `flower-public` |
| `clamav`      | 3310        | document AV scanning                                                              |
| `mailpit`     | 1025 / 8025 | dev SMTP / web UI                                                                 |
| `pgbouncer`   | 6432        | spike only — transaction- & session-pool test for 0.6                             |

**Application processes:**

| process           | port | purpose              |
| ----------------- | ---- | -------------------- |
| `api`             | 3001 | REST `/v1` + OpenAPI |
| `realtime`        | 3002 | WebSocket / SSE      |
| `worker`          | 3011 | metrics only         |
| `scheduler`       | 3012 | metrics only         |
| `super-admin-web` | 3100 | Next.js dev          |
| `owner-web`       | 3200 | Next.js dev          |
| `pos-pwa`         | 3300 | Next.js dev          |
| `customer-web`    | 3400 | Next.js dev          |

All 16 ports verified free on the dev machine (2026-09-03).

## E · Verification

See [`PHASE-0-CHECKLIST.md`](PHASE-0-CHECKLIST.md).

## F · Git checkpoint strategy (steps 3, 11)

- **Init**: `git init` on `main`. No force pushes, ever. No history rewrite —
  revert-forward only.
- **Commits**: Conventional Commits, commitlint-enforced. One commit per completed,
  verified task (0.1 … 0.13); the body records what was verified. Never commit a red
  state to `main`. Trailers on every commit (`Co-Authored-By` + `Claude-Session`).
- **Branching**: trunk-based. Each task on a short-lived `phase-0/<task>-<slug>`
  branch; a self-review PR runs the CI gate; merge to `main` when verification is
  green.
- **Checkpoint tags (annotated)**: `spec-frozen-v0.4` (after steps 1–2) ·
  `phase-0-infra` (after 0.9) · `phase-0-ci` (after 0.10) · `phase-0-complete`
  (after 0.13, full checklist green; references `PHASE-0-RESULTS.md`) · thereafter
  one per phase.
- **Recovery**: `main` is always buildable; tags are the restore points; the RLS
  spike verdict (ADR-0010) is a hard gate — if it says "Kysely fallback," that task
  is appended and completed **before** `phase-0-complete`.
- **Never committed**: secrets, `.env`, `node_modules`, build output, coverage.
  Spike code is committed once for the record, then may be removed later.

## Stop point

After Task 0.13: **STOP at `phase-0-complete`** and return the full Phase 0
completion report. Do **not** begin Phase 1 without explicit owner approval.
