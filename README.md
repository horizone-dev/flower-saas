# Flower SaaS

Multi-tenant florist commerce SaaS for the GCC (UAE, KSA, Qatar, Kuwait, Bahrain,
Oman). A modular monolith: one TypeScript codebase with `api` / `worker` /
`scheduler` / `realtime` runtime roles, four user-facing web apps, PostgreSQL +
Redis + object storage.

> **Status:** Phase 0 — repository & infrastructure foundation. No domain code yet.
> The approved architecture is frozen in [`docs/architecture/ARCHITECTURE.md`](docs/architecture/ARCHITECTURE.md).
> Permanent engineering rules live in [`CLAUDE.md`](CLAUDE.md).

## Prerequisites

| Tool           | Version            | Notes                                   |
| -------------- | ------------------ | --------------------------------------- |
| Node.js        | 24.20.0 (`.nvmrc`) | `nvm use` / `fnm use`                   |
| pnpm           | 10.34.5 (pinned)   | `corepack enable` — version is enforced |
| Docker Desktop | 4.89+ (Engine 29+) | WSL2 backend, linux/amd64 containers    |

## One-command dev start

```bash
corepack enable
pnpm install --frozen-lockfile
cp .env.example .env
pnpm dev:up          # docker compose up + wait-healthy (postgres, redis, minio, clamav, mailpit)
pnpm dev             # all app processes via turborepo
```

Verify:

```bash
pnpm -w typecheck && pnpm -w lint && pnpm -w test && pnpm -w build
curl -fsS localhost:3001/healthz
curl -fsS localhost:3001/readyz
```

## Repository layout

```
apps/          api · worker · scheduler · realtime · super-admin-web · owner-web · pos-pwa · customer-web
packages/      config · db · shared-types · permissions · api-client · realtime-client · money · uom · i18n · ui · testing
infra/         docker · terraform
tooling/       scripts · spikes/rls
docs/          architecture · decisions · conventions · phase-0   ← specification of record
```

## Documentation

- [`docs/architecture/ARCHITECTURE.md`](docs/architecture/ARCHITECTURE.md) — frozen approved architecture (v0.4)
- [`docs/architecture/ROADMAP.md`](docs/architecture/ROADMAP.md) — 11-phase roadmap
- [`docs/architecture/SECURITY.md`](docs/architecture/SECURITY.md) — request pipeline, tenant/branch isolation, RLS
- [`docs/decisions/DECISION-LOG.md`](docs/decisions/DECISION-LOG.md) — Z-1…Z-14, ZF-1…ZF-9 (all approved 2026-09-03)
- [`docs/conventions/`](docs/conventions/) — coding, API, DB, testing, git conventions
- [`docs/phase-0/`](docs/phase-0/) — Phase 0 plan, checklist, results
