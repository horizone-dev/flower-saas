# Post-Phase-0 remediation — ultra-review batch

> Date: 2026-09-03 · Branch: `phase-0/post-review-remediation` · One commit.
>
> After `phase-0-complete` was accepted, a multi-agent code review ("ultra-review")
> ran against the full Phase 0 diff (`d2db275..c1ca217`). It found **no Critical
> finding and nothing touching tenant isolation, RLS, auth, the guard pipeline or
> secrets**. It produced 12 verified findings; the owner approved fixing all of
> them **except F8/F9** (realtime protocol questions — recorded for Phase 2 in
> [`../phase-2/REALTIME-PROTOCOL-INPUTS.md`](../phase-2/REALTIME-PROTOCOL-INPUTS.md)).
>
> **The `phase-0-complete` tag is NOT moved.** It stays the historical Phase 0
> baseline at `c1ca217`. This remediation is a separate, independently-verified
> commit on top of it, landed before Phase 1 begins.

## Findings fixed

**F1 — High — `apps/scheduler/package.json`.** `@flower/service-runtime` moved
`devDependencies` → `dependencies` (matching worker/realtime). It is a runtime
import in `src/main.ts` and was being pruned by `pnpm deploy --prod`, so the
deployed image would crash at boot with `ERR_MODULE_NOT_FOUND`.
_Verified:_ `docker build` of the scheduler image →
`/out/node_modules/@flower/service-runtime` present with its `dist/`; the
container boots past all imports.

**F2 — High — `packages/money/src/money.ts` (+ `money.test.ts`).** `allocate()`
now takes the base shares with **floor division**, so every remainder is in
`[0, total)` and the residual to distribute is always ≥ 0 — the largest-remainder
rule is then sign-correct. The prior code divided toward zero, and for a
**negative amount with unequal weights** handed the residual to the part that had
already divided evenly (`-70 / [1,2,3]` gave `[-11,-23,-36]` instead of
`[-12,-23,-35]`). The sum invariant held either way, so it was a silent
wrong-split. Added negative unequal-weight, mirror, spread and 3-decimal-negative
test cases.
_Verified:_ `@flower/money` 28 tests green (was 24).

**F3 — Medium — `infra/docker/node-service.Dockerfile`.**
`pnpm --filter "@flower/${APP}" build` → `pnpm turbo run build --filter "@flower/${APP}"`
so the app's workspace dependencies (`@flower/db`, `@flower/service-runtime`,
`@flower/permissions`, `@flower/shared-types`) get a `dist/` before the app's
`tsc` runs (matching `web.Dockerfile`, which already used turbo).
_Verified:_ `docker build` of `api` (3 workspace deps) and `scheduler` — both
images build; the `api` container reaches "Nest application successfully started".

**F4 — Medium — `infra/docker/web.Dockerfile` + three `public/.gitkeep` files.**
The unconditional `COPY …/public` failed the build for `super-admin-web`,
`owner-web` and `customer-web` (only `pos-pwa` had a `public/` dir). Added a
`.gitkeep` to each so every app keeps the directory and the COPY always succeeds.
_Verified:_ `docker build` of `owner-web` (no static assets) → succeeds.

**F5 — Low/Med — `apps/scheduler/src/main.ts`.** Repeatable jobs were registered
only inside a one-shot `if (redisOk)` with no retry, so a boot-time Redis blip
left the process alive but idle with nothing scheduled, forever. It now
**fails fast**: if `connectRedis` fails it throws → `process.exit(1)` → the
orchestrator restarts it. Full retry / leader election is Phase 2.
_Verified:_ container run against an unreachable Redis exits with
`Redis unreachable … cannot register schedules`.

**F6 — High — `apps/scheduler/package.json`, `apps/realtime/package.json`.** Both
call `createLogger(…, pretty=true)` in development but did not declare
`pino-pretty` (worker and api do); `pnpm dev` would fail spawning the pretty
transport. Added `pino-pretty@13.1.3` to `devDependencies` of both.
_Verified:_ lockfile carries the dep on both importers; full build/typecheck/test
green.

**F7 — Medium — `pnpm-workspace.yaml` + new `tooling/scripts/` package.**
`tooling/scripts/` had no resolvable ESLint flat config, so the pre-commit hook
aborted on any staged script there, and the directory sat outside
`turbo run lint` / CI. It is now the `@flower/tooling-scripts` workspace package
with its own `eslint.config.js` and a `lint` script.
_Verified:_ `pnpm -w lint` = 30 tasks (was 29); `eslint tooling/scripts/check-ws.mjs`
is clean.

**F10 — Low — `tooling/scripts/wait-healthy.sh`.** The `minio-init` one-shot was
treated as success on any `exited` state. It now reads the container exit code
(with a `|`-separated `docker compose ps` format, so an empty `.Health` column
does not shift the fields) and requires exit 0; a non-zero exit prints the
init logs and fails.
_Verified:_ ran against the live stack — `minio-init` exit 0 → "all services
healthy"; a simulated non-zero exit → FATAL.

**F11 — Low — `packages/service-runtime/src/index.ts`.** The `/readyz` handler had
no `.catch`; a readiness check that rejected would hang the request with no
response and log an unhandledRejection. Added a `.catch` that answers 503.
_Verified:_ `@flower/service-runtime` 5 tests green.

**F12 — Low — `packages/service-runtime/src/index.ts`.** `connectRedis` and
`redisHealthy` never `clearTimeout`-ed the race timer on the success path,
keeping the event loop alive for up to 1–5 s and slowing clean shutdown / test
teardown. Added `finally { clearTimeout(timer) }`.
_Verified:_ the unreachable-host `redisHealthy` test still resolves `false`
quickly; suite green.

## Findings recorded, not changed

- **F8** — the realtime gap check is per-`tenant:branch:resourceType` topic, but
  `seq` is documented per-tenant-global, so normal cross-topic interleaving can
  trigger a false `gap-needs-resync`.
- **F9** — `EventReducer.offer` returns `stale` without advancing the topic seq
  mark, which can later feed a false gap.

Both live in a Phase 0 seed (`packages/realtime-client`) whose wire protocol is
designed in Phase 2; fixing them now in isolation would pre-empt the
`seq`-granularity decision. Recorded in
[`../phase-2/REALTIME-PROTOCOL-INPUTS.md`](../phase-2/REALTIME-PROTOCOL-INPUTS.md),
in source comments, and in ROADMAP Phase 2.

## Verification (this branch, before commit)

- `pnpm -w typecheck` — 29 tasks ✅
- `pnpm -w lint` — 30 tasks ✅ (F7 adds `@flower/tooling-scripts`)
- `pnpm -w build` — 20 tasks ✅
- `pnpm turbo run test --concurrency=2 --force` — 29 tasks ✅, including
  `@flower/db` (4, Testcontainers Postgres), `spike-rls` (21, PgBouncer),
  `@flower/testing` (12, real containers), `@flower/money` (28),
  `@flower/service-runtime` (5)
- `@flower/config test:negative` — "NEGATIVE TEST PASSED" ✅
- `docker build` — `api` + `scheduler` (node-service.Dockerfile), `owner-web`
  (web.Dockerfile) — all build ✅; `api` boots to "Nest application successfully
  started"
- `docker compose up` + `wait-healthy.sh` — 5 infra services healthy, `minio-init`
  exit-0 handled ✅
- GitHub Actions `verify` + `security` — pending push
