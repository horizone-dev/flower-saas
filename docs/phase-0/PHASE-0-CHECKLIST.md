# Phase 0 verification checklist (§E)

> Every item must be **green** before the `phase-0-complete` tag. Results (actual
> command output) are recorded in [`PHASE-0-RESULTS.md`](PHASE-0-RESULTS.md).
> Do not fabricate results. Do not skip a failed check. Do not weaken RLS,
> security, isolation, lint or tests to make a check pass.

## Commands (run from the repo root)

```bash
pnpm install --frozen-lockfile
pnpm -w typecheck
pnpm -w lint                      # boundary + no-raw-prisma + route-permission + no-scope-from-request
pnpm -w test                      # Vitest unit (money 2&3-dp, uom fractional, config rules)
pnpm --filter @flower/db test     # Testcontainers: migrate a fresh PG, assert baseline
pnpm --filter spike-rls test      # cross-tenant read blocked under session- AND transaction-pool
pnpm -w build                     # every app + package builds
docker compose up -d && ./tooling/scripts/wait-healthy.sh
curl -fsS localhost:3001/healthz              # 200
curl -fsS localhost:3001/readyz               # 200 {db,redis,storage,migrations: ok}
curl -fsS localhost:3002/healthz              # realtime up
node tooling/scripts/check-ws.mjs             # WS connect / ack / close
pnpm --filter @flower/testing test            # probe-harness self-test
# open localhost:3100 / 3200 / 3300 / 3400 → each renders "API: healthy"
```

## Sign-off checklist

- [ ] `docker compose up` from clean → 5 infra services healthy in < 60s
      (postgres, redis, minio, clamav, mailpit)
- [ ] every app builds and boots; `/healthz` + `/readyz` green; POS PWA installable
- [ ] CI green on a fresh branch — all gates (typecheck, lint, unit, db-migration,
      build, SBOM, audit, Trivy, gitleaks)
- [ ] **negative test:** a boundary violation fails lint
- [ ] **negative test:** a controller route with no `@RequirePermission` / `@Public`
      fails lint
- [ ] **negative test:** reading `tenant_id` / `branch_id` from a request fails lint
- [ ] **negative test:** a non-Conventional commit message and an unformatted file
      are blocked by hooks
- [ ] money: AED (2dp) + KWD (3dp) rounding suites pass; split residual allocation
- [ ] uom: fractional (1.5 m) + pack (carton→12) conversion pass
- [ ] db: fresh PG → `migrate deploy` → expected baseline asserted by a test
- [ ] **RLS spike (hard gate):** tenant B cannot read tenant A rows under
      **session-pool AND transaction-pool** PgBouncer; a query missing the GUC
      returns zero rows; **ADR-0010 verdict section written** (go / go+Kysely). If
      "Kysely fallback": the appended task is done too.
- [ ] realtime: WS connect / ack / close
- [ ] probe harness spins a stack up + down and its self-test passes
- [ ] `docs/` complete: ARCHITECTURE, DOMAIN-MODEL, ROADMAP, SECURITY, GLOSSARY,
      CHANGELOG, DECISION-LOG, ADR-0001…0013, 5 conventions docs, CLAUDE.md
- [ ] `PHASE-0-RESULTS.md` written with actual outputs
- [ ] tags placed: `spec-frozen-v0.4`, `phase-0-infra`, `phase-0-ci`,
      `phase-0-complete`
- [ ] no Salon SaaS files, data, containers, volumes or networks touched
- [ ] `git status` clean on `main`; `git remote -v` = the Flower origin; pushed
