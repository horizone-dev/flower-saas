# Phase 2-core — verification results

> Produced by **Task 2.8** (`phase-2/2.8-core-verify`). Records what Phase 2-core
> (Tasks 2.0 → 2.8) delivered, the evidence for every hard gate, the security
> review outcome, and the explicit boundary of what was **not** built.
>
> Governing plan: [`PHASE-2-CORE-PLAN.md`](PHASE-2-CORE-PLAN.md) (approved
> 2026-09-04, MVP-oriented split OD-P2-2; 10 locked decisions OD-P2-1..10 + 4
> architecture corrections + 3 implementation constraints FC-1/2/3). Task 2.8
> scope was expanded by the owner on 2026-09-05 with 13 further locked decisions
> (retention + operational visibility now delivered here, not just verified).

---

## 1. Integrated commits

| Task                                                                 | Commit(s)                            | Landed on `main`                 |
| -------------------------------------------------------------------- | ------------------------------------ | -------------------------------- |
| Plan + backlog                                                       | `05f7414`                            | yes                              |
| 2.0 — ADR-0017 protocol                                              | `1b713d5`, `d6bd54d` (clarify)       | yes                              |
| 2.1 — schema (expand)                                                | `7d4369f`                            | yes                              |
| 2.2 — idempotency store                                              | `d3fdc46`, `976c729` (hardening)     | yes                              |
| 2.3 — backend extraction + runtime frameworks (FC-3)                 | `43f9bd7`                            | yes                              |
| 2.4 — outbox dispatcher → durable Stream                             | `5d2fb0f`, `ba440fd` (remediation)   | yes                              |
| 2.5 — auth/session primitive + relay + gateway fanout                | `fd41eed`, `9681493`, `691ba43` (CI) | yes                              |
| 2.6 — resume / replay / F8-F9 reducer rewrite                        | `d2fb5da`, `2e9164e` (remediation)   | yes                              |
| ADR-0018 / ADR-0019 (docs only)                                      | `3ca966b`                            | yes                              |
| 2.7 — localization ref data + service + provisioning fiscal defaults | `f0ecbd4`, `1832326` (fix)           | yes                              |
| 2.8 — retention + operational visibility (A)                         | `41c84b5`                            | branch `phase-2/2.8-core-verify` |
| 2.8 — realtime CI job + probe confirm (B)                            | `853659d`                            | branch `phase-2/2.8-core-verify` |
| 2.8 — results + doc reconciliation (C)                               | _this commit_                        | branch `phase-2/2.8-core-verify` |

`main` before Task 2.8: `1832326`. Task 2.8 branch base:
`183232638b8cf3fe6bd49898ced0ac500510bd1b`.

**Final integrated `main` commit + `phase-2-core-complete` tag:** to be stamped
after owner-approved integration (fast-forward preferred) and push-to-main CI
green on all four jobs, per plan §6 and Task 2.8 decisions 11–12.

### Local verification at the Task 2.8 branch HEAD

| Check                                                                                    | Result                                                        |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `turbo run typecheck` (whole workspace)                                                  | 66/66 tasks ✅                                                |
| `turbo run lint` (boundaries + no-raw-prisma + route-permission + no-scope-from-request) | ✅                                                            |
| `turbo run build` (every app + package)                                                  | 66/66 ✅                                                      |
| `turbo run test` (whole workspace, Testcontainers)                                       | **33/33 tasks, exit 0**                                       |
| — `@flower/api`                                                                          | 171 passed                                                    |
| — `@flower/worker`                                                                       | 87 passed (incl. `stream-retention/` 18, `outbox/metrics*` 9) |
| — `@flower/realtime`                                                                     | 44 passed                                                     |
| — `@flower/scheduler`                                                                    | 12 passed                                                     |
| — `@flower/db` (migration + `gcc-reference-data`)                                        | 43 passed                                                     |
| — `@flower/backend` (context + scoped-repo + boundary)                                   | 17 passed                                                     |
| — `spike-rls` (RLS + PgBouncer)                                                          | 21 passed                                                     |
| — `@flower/testing` (harness + probes + boundary)                                        | 16 passed                                                     |
| `@flower/config` negative test (boundary + scope violation must fail lint)               | ✅                                                            |
| cumulative `security-review` (`phase-1-complete` → HEAD)                                 | no Critical / High / Medium (§4)                              |
| real compiled-runtime smoke (scheduler → worker XTRIM → gateway resync)                  | ✅ (§4b)                                                      |

---

## 2. Task-by-task summary

### 2.0 — ADR-0017 realtime protocol + F8/F9 resolution

ADR-0017 written and frozen: per-tenant-global immutable `seq` (logical/diagnostic
only); the **Redis Stream entry ID / retained-stream position is the single
correctness basis** for resume and retention-gap detection; **no arithmetic
`seq`-distance resync trigger at any granularity** (this is what re-created F8);
scanned cursor advances across every entry the gateway reads for a client,
including filtered ones (F8); scanned position and resource state are separate
concerns (F9); `outbox → durable Stream per tenant → relay → Redis Pub/Sub →
gateways` fanout (a consumer group is never the socket-broadcast path);
time-based `XTRIM MINID` retention, never `MAXLEN`. ADR-0009 / ADR-0013 / ADR-0016
amended.

### 2.1 — Phase 2-core schema (expand migration `20260904130000_phase_2_core_infra`)

New tables: `idempotency_key` (**non-partitioned**, unique `(tenantId, scope,
principalId, key)`); `translation`; localization reference tables (`Country`,
`Currency`, `CountryTaxConfig`, `TaxCategory`, `TaxRate`, `Locale`, `Holiday` —
effective-dated). New columns: `company.countryCode` / `defaultCurrency` /
`fiscalConfig`; `outbox.seq` / `attempts` / `availableAt` / `lastError`;
`audit_log.prevHash` / `entryHash` (nullable, unwritten — OD-P2-1). RLS
`ENABLE + FORCE` + policy on every new tenant-owned table; reference tables are
`flower_app` SELECT-only. Forward-only; baseline assertion passes.

### 2.2 — Idempotency store

Per-`(principal, key)` store with request-hash match → stored response (handler
runs once), hash mismatch → 409, concurrent same key → single execution, opaque
`claim_token` (migration `20260904150000_idempotency_claim_token`), bounded
owner-wait poll (`IDEMPOTENCY_WAIT_MS`), stale-`PENDING` recovery (FC-2),
per-principal + per-tenant isolation, no auth/secret route decorated, no
token/secret in a snapshot.

### 2.3 — Minimum backend extraction + runtime frameworks (FC-3)

`@flower/backend` = `DbService` / `ScopedRepository` / `PlatformRepository` /
`RequestContext` + ALS / root logger / `backendEnvSchema` only. `apps/api`
`common/{context,data,db,logger}` became thin re-export barrels (zero import
churn). `apps/worker` `ProcessorRegistry` + BullMQ framework (retry / backoff /
DLQ, `probe` queue only). `apps/scheduler` repeatable-job framework (`probe`
schedule only). Cross-package boundary enforced by a dependency-free import
scanner in `@flower/testing` (`checkForbiddenImports`). Two real bugs found + fixed
(eager `rootLogger` crashed `dist/main.js` boot → now lazy; a `packages/config`
ESLint-factory bug that broke lefthook batching).

### 2.4 — Outbox dispatcher → durable per-tenant Redis Stream

Dedicated loop in `apps/worker` (not BullMQ), migration
`20260904180000_outbox_dispatcher`. Two phases per tick: **allocation**
(`pg_try_advisory_xact_lock(hashtext('outbox_seq:'||tenantId))` per-tenant
leader, durable `outbox_tenant_seq` counter row via `INSERT … ON CONFLICT DO
UPDATE … RETURNING`, stamp committed **before** any `XADD` = FC-1) / **publish**
(`pg_try_advisory_xact_lock(hashtext('outbox_publish:'||tenantId))` — a
**second** lock serialising publish per tenant while different tenants stay
concurrent, remediation concern #1; `ORDER BY seq LIMIT 1 … FOR UPDATE`, `XADD` +
`dispatchedAt` in one txn). Bounded backoff forever, **no dead-letter table**
(see §7). Narrowly-GRANTed `flower_dispatcher` role (remediation concern #3,
migration `20260904200000_outbox_dispatcher_least_privilege`). Envelope =
ADR-0017 §3 fields only, never the row's `payload` (secret-safety).

### 2.5 — Shared auth/session primitive + realtime relay + gateway fanout

`SessionAuthenticator` / `JwtService` / `RedisSessionStore` extracted into
`@flower/backend`. `apps/worker` relay: durable Stream → `rt:live:{tenantId}`
Pub/Sub via consumer group `relay` + `XAUTOCLAIM` crash recovery (OI-P2-2 —
worker loop, not the realtime process). `apps/realtime` Fastify + WS gateway:
server-derived topic authz (tenant + branch, `isAuthorized`), per-tenant live
fanout (OI-P2-4), session revocation via `rt:revoke:{sessionId}`, `event_id`
dedup. First PR ever opened in the repo (PR #1) — surfaced + fixed a real
gitleaks-action CI gap (`GITHUB_TOKEN` for `pull_request` scans).

### 2.6 — Resume / replay / dedup / reorder + fault injection

Client-held Stream cursor only (OI-P2-5 — no durable server-side per-client
cursor). Cursor rules 1–8 in `apps/realtime/src/gateway/{cursor,hub}.ts`'s
`resume()`. Wire protocol `resume` / `event{cursor,event}` / `resumed` /
`resync-required` + a `heartbeat{cursor}` frame for a scanned-but-filtered live
entry. `packages/realtime-client` reducer **fully rewritten** — `lastSeqByTopic`
/ `maxSeqGap` / `gap-needs-resync` **deleted from the type** (F8/F9 structurally
resolved). Race-free replay→live handoff proven by a deterministic test.
Fault injection: a mid-replay Redis connection loss → safe `RESUME_FAILED` frame.

### 2.7 — Localization reference data + service + provisioning fiscal defaults

`apps/api/src/modules/localization/` — `LocalizationRepository extends
ScopedRepository` (reads global reference tables, RLS-exempt), `LocalizationService.
forCompany(companyId, at)` resolves from `company.country_code` **never
`tenant.region`**, effective-dated tax regime / rates; `TranslationService` +
closed `TRANSLATABLE_ENTITY_FIELDS` allowlist; `EInvoicingProvider` port stub. 2
routes (`GET /v1/localization/reference`, `GET /v1/localization/companies/:companyId`,
both `@RequirePermission('settings:tenant:manage')`, latter `@ScopedParam`).
GCC reference data (`packages/db/prisma/gcc-reference-data.ts`) — verified
official values, sources + effective dates in `GCC-FISCAL-REFERENCE.md`. No new
migration (all columns/tables from 2.1). Provisioning + `OrgRepository.
createCompany` resolve country → currency + `fiscalConfig: {}` atomically.

### 2.8 — Verification pass + retention + operational visibility + reconciliation

**Delivered (not just verified) — owner decisions 1 & 2:**

- **Realtime Stream retention** — `apps/worker/src/stream-retention/`:
  `retentionFloorId` (pure — the whole time-based policy), `trimTenantStream`
  (`XTRIM … MINID [~]`), `retentionTick` (one sweep over `discoverTenantStreams`),
  `makeStreamRetentionProcessor` on a new `stream-retention` BullMQ queue.
  `apps/scheduler` enqueues `stream-retention.tick` (`STREAM_RETENTION_SWEEP_
INTERVAL_MS`, default 1h). Worker window `STREAM_RETENTION_MS` (default ≈ 24h).
  **`MINID` only, never `MAXLEN`.**
- **Operational visibility** — `apps/worker/src/outbox/metrics.ts` +
  `stream-retention/stream-metrics.ts`, wired into the worker `/metrics`:
  bounded aggregate outbox lag (undispatched count, oldest-undispatched age,
  with-failures count) + stream growth (tenant-stream count, max / total length).
  **Scalability rule honoured** — no unbounded per-tenant metric series; a
  threshold breach (`OUTBOX_BACKLOG_HIGH`, `OUTBOX_OLDEST_TOO_OLD`,
  `REALTIME_STREAM_GROWTH_ABNORMAL`) names the worst tenant in a structured
  `logger.warn` line only. Snapshot reads through the least-privilege
  `flower_dispatcher` role.
- **CI `realtime` job** — build-blocking, least-privilege `permissions:
{ contents: read }`; runs the full `apps/realtime` acceptance suite +
  `apps/worker` realtime-relay + stream-retention.
- **HG-OUTBOX wording reconciliation** — §7 below.
- **`REALTIME-PROTOCOL-INPUTS.md`** — authority banner (ADR-0017 governs).

---

## 3. Hard-gate evidence matrix

| Gate                   | Status | Evidence (named tests / artefacts)                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ---------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **HG-RLS**             | ✅     | `apps/api` `*.integration.test.ts` RLS cases; `localization.integration.test.ts` "reference tables readable by flower_app with NO app.tenant_id … and flower_app cannot write" (`permission denied`); `packages/db` spike-rls suite.                                                                                                                                                                                                                                                                           |
| **HG-SCHEMA**          | ✅     | `packages/db` migration/baseline tests; `idempotency_key` non-partitioned + unique `(tenantId, scope, principalId, key)`; `audit_log.prevHash/entryHash` nullable + unwritten.                                                                                                                                                                                                                                                                                                                                 |
| **HG-IDEM**            | ✅     | `apps/api` idempotency integration + concurrency suite: replay / hash-mismatch(409) / concurrent-single-exec / cross-principal isolation (FC-2) / stale-`PENDING` recovery (FC-2) / tenant isolation / snapshot-scrub / auth-route exclusion.                                                                                                                                                                                                                                                                  |
| **HG-RUNTIME**         | ✅     | `apps/worker/src/bootstrap.integration.test.ts` (7/7 — separate process, app context over `@flower/backend`, job round-trip, DLQ, SIGTERM drain, relay wired, **retention processor runs a real XTRIM sweep**); `apps/scheduler/src/bootstrap.integration.test.ts` (5/5).                                                                                                                                                                                                                                      |
| **HG-BOUNDARY** (FC-3) | ✅     | `apps/{worker,scheduler,realtime}/src/boundary.test.ts` — `checkForbiddenImports` zero violations + a teeth test that flags a planted bad import; every Phase 1 suite + probe green post-extraction.                                                                                                                                                                                                                                                                                                           |
| **HG-OUTBOX**          | ✅     | `apps/worker/src/outbox/dispatcher.integration.test.ts` (Postgres+Redis, no mocks): at-least-once; FC-1 crash-between-`XADD`-and-ack → identical `event_id` + `seq`, single effect; same-tenant strict publish order under a deliberately-held lock; per-tenant isolation ("a failed allocation … never blocks a subsequent tenant"); bounded backoff + recovery; envelope never carries `payload`; spoofed payload routing fields never override real `branch_id`/`tenant_id`. **No dead-letter table** — §7. |
| **HG-RT-AUTHZ**        | ✅     | `apps/realtime` `gateway.integration.test.ts` — server-derived topics; cross-tenant / cross-branch subscribe denied; guard re-runs on subscribe + token refresh; probe suite carries `/v1/localization` + realm-axis cases.                                                                                                                                                                                                                                                                                    |
| **HG-RT-FANOUT**       | ✅     | `apps/realtime` two-gateway fanout test; live duplicate suppressed by `event_id`; `apps/worker` relay tests (`{cursor, event}` wrapper verbatim).                                                                                                                                                                                                                                                                                                                                                              |
| **HG-RT-REVOKE**       | ✅     | `apps/realtime` timed multi-gateway revocation test (`rt:revoke:{sessionId}` → sockets close < 5s on both); real-runtime smoke measured ~530 ms end to end.                                                                                                                                                                                                                                                                                                                                                    |
| **HG-RT-RESUME**       | ✅     | `apps/realtime/src/resume.integration.test.ts` (10/10 — cursor rules 1–8, F8, F9, unrelated-branch burst → no resync + cursor advances, retention-gap → resync, within-retention exact replay, FC-1 identity, scope-narrowing mid-replay, race-free handoff, mid-replay Redis loss); `apps/worker/src/stream-retention/retention.integration.test.ts` (7/7 — proofs 1–8) + `retention.test.ts` (11/11); **compiled-runtime smoke** (§4b).                                                                      |
| **HG-LOCALE**          | ✅     | `apps/api/src/modules/localization/localization.integration.test.ts` (6/6) + `translation.integration.test.ts` (4/4); `packages/db/prisma/gcc-reference-data.test.ts` (currency-exponent parity with `@flower/money`, QA/KW = `NONE` with zero rate rows, effective dating).                                                                                                                                                                                                                                   |
| **HG-NO-DOMAIN**       | ✅     | §5 below — no MVP-domain module/table/engine added; boundary lint + this review.                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **HG-OFFLINE**         | ✅     | §5 — no Class-B/C offline sale path; the tenant flag stays inert; Z-6 unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **HG-PROBE**           | ✅     | `apps/api/src/probes/cross-tenant.probe.test.ts` (9/9) — Phase 1 axes green + `/v1/localization` company read (tenant+company scoped, cross-tenant 403/404, platform-token rejected) + global reference read leaks no tenant/company id + positive control (ownerA → 200) + coverage meta-test ("every non-@Public route probed or on the safe list") + guard-pipeline teeth test.                                                                                                                             |
| **HG-CI**              | ⏳     | Local full workspace `turbo run test` = **33/33 tasks, exit 0**; `security-review` skill (cumulative `phase-1-complete` → HEAD) = **no Critical/High/Medium** (§4). The branch PR run (`verify` + `security` + `e2e` + **`realtime`**) is the remaining gate — stamped here once green.                                                                                                                                                                                                                        |
| **HG-AUDIT**           | ✅     | Phase 1 audit suites green (append-only, RLS, registry, atomic writes); hash-chain columns present, nullable, unwritten (OD-P2-1 / deferred to B7 / Phase 4).                                                                                                                                                                                                                                                                                                                                                  |

---

## 4. Security review

`security-review` skill, cumulative **`phase-1-complete` → the Task 2.8 branch
HEAD** (owner decision 4 — findings are not dismissed because an individual task
previously passed its own review), read against the named cumulative surfaces:
the outbox dispatcher + `flower_dispatcher` role, the realtime relay + WS gateway
(token/session auth, server-derived topic authz, resume/replay), the idempotency
store, the localization module (translation allowlist + scoped params), the
`@flower/backend` extraction, and the Task 2.8 retention job + `/metrics`.

**Result: no Critical / High / Medium findings.** The Task 2.8 additions
introduce no new external input surface — the retention sweep is driven only by
a Redis `SCAN` over `rt:stream:*` (real key names) and the wall clock, every
`XTRIM` / `XLEN` is scoped to one `streamKey(tenantId)`; `outboxLagSnapshot`'s
two `$queryRawUnsafe` calls are **constant SQL strings with zero interpolation**
run through the least-privilege `flower_dispatcher` role; the worker `/metrics`
payload carries **only bounded non-sensitive aggregates** (no tenant id, no PII,
no secret — `worstTenantId` is confined to a `logger.warn` line); the new CI
`realtime` job is `permissions: { contents: read }` with no untrusted-input
interpolation. Cumulative surfaces (2.0–2.7) were re-scanned and are unchanged by
2.8.

Per-task reviews already run and clean: Task 2.4 (dispatcher least-privilege +
publish ordering remediation), Task 2.5 (PR #1), Task 2.6 (PR #2, one real bug —
mid-replay Redis loss — fixed), Task 2.7 (PR #4). The CI `security` job
(gitleaks / osv-scanner / trivy / SBOM) is the automated half — stamped from the
PR run.

## 4b. Real compiled-runtime smoke (owner decision 8)

Ad-hoc, against **real `dist/main.js` processes** + a **real docker-compose
Postgres + Redis** (no Testcontainers, no mocks), driven end to end:

```
docker compose up postgres redis  →  prisma migrate deploy
  →  node apps/scheduler/dist/main.js   (STREAM_RETENTION_SWEEP_INTERVAL_MS=3000)
  →  node apps/worker/dist/main.js      (STREAM_RETENTION_MS=60000)
  →  node apps/realtime/dist/main.js
seed rt:stream:{tenant} = 350 epoch-old entries + 1 recent entry (xlen 351)
  →  scheduler enqueues stream-retention.tick
  →  worker retention processor runs XTRIM … MINID ~
  →  PASS: entry 1-1 trimmed, recent entry retained (xlen 351 → 10),
           XINFO recorded-first-entry-id advanced to 342-1
real WS client, resume cursor = 1-1 (below the retained floor)
  →  PASS: {type:'resync-required', cursor:<current tail>}
real WS client, resume cursor = <recent> (within retention), one live event added
  →  PASS: {type:'resumed', cursor:<new tail>}, replayed the after-floor event
```

Proves the full chain **scheduler job → worker retention execution → Stream old
entry trimmed → recent entry retained → gateway/client resume below floor →
resync-required** on the actual compiled runtime, not mocked/unit behaviour.

---

## 5. What was explicitly NOT built (HG-NO-DOMAIN, HG-OFFLINE)

Phase 2-core is infrastructure only. **None** of the following exists after Task
2.8:

- Product / Catalog implementation (ADR-0018 is **documentation only**)
- Inventory (movement ledger, balances, reservations, availability)
- POS / sales domain, Orders, cart lifecycle
- Payments domain, provider payment adapters (ports only, Z-4)
- Credit / Receivables, Customer Settlement, allocation, invoice payment-state
  (ADR-0019 is **documentation only**)
- Refund / Cancellation / Cancellation Charge, Customer Ledger
- Accounting / GL, journal entries, Z-Reports, COGS
- Tax **calculation** engine (only effective-dated reference **data** + read)
- e-invoicing provider adapter (only the `EInvoicingProvider` **port** stub)
- Full audit hash chain + tamper-evidence job (nullable columns only — B7 / Phase 4)
- Documents domain, Notifications / email / WhatsApp / SMS channels (B2 / B3 / B4)
- Registered-device foundation (B5 — the Phase-1 pipeline step stays a no-op)
- Realtime SSE fallback (B9); UI i18n / Arabic / RTL (B10 — data model is ready)
- Any domain worker/scheduler job (B8); idempotency-key TTL sweep (B14)
- **Offline Class-B / Class-C sales** — no path added; the tenant flag is inert;
  financial + inventory sales stay ONLINE-ONLY (Z-6)
- Phase 3 and beyond

`apps/worker` / `apps/scheduler` still run **only** infra queues/schedules
(`probe`, `stream-retention`, `dead-letter`). No fifth/sixth app; no Staff App.

---

## 6. Deferred — `PHASE-2-BACKLOG.md`

The Phase 2 remainder is **not dropped** — B1–B14 in
[`PHASE-2-BACKLOG.md`](PHASE-2-BACKLOG.md), each with the first consumer that
forces it to land and why it is safe to defer. Re-checked at the start of every
subsequent phase. Task 2.8 delivered the two items that were flagged
"core, remaining, before `phase-2-core-complete`" (Stream `XTRIM` retention +
outbox-lag observability) — these are **not** backlog items and are now done.

---

## 7. HG-OUTBOX wording reconciliation (owner decision 3, option a)

The plan originally described persistent outbox-publish failure as
"poison row → dead-letter" / "dead-letter table / alarm after N attempts". Task
2.4's **accepted** implementation (2026-09-04) does **not** work that way, and
**no `outbox_dead_letter` schema or table is added**. The plan text (§2.4, §4
HG-OUTBOX, §5 matrix, §7 corrections table) is reconciled to the real behaviour:

- **Durable at-least-once.** A committed `outbox` row is published at least once;
  `event_id` and `seq` are stamped once, persisted before `XADD`, and reused
  verbatim on any crash-induced republish (FC-1).
- **Bounded retry, forever.** On publish failure: `attempts++`,
  `availableAt = now() + backoff` (`{ baseMs: 1000, maxMs: 300000 }`),
  `lastError` set (credential-scrubbed, length-capped). The row is **never
  discarded** and **never moved**.
- **No global stall.** A backed-off row is excluded from its own tenant's
  `ORDER BY seq LIMIT 1 WHERE availableAt <= now()` selection until it is due, so
  the tenant's later rows keep flowing past it. Allocation is per-tenant
  `try/catch` under a per-tenant advisory lock, and per-tick work is bounded
  (`tenantBatchSize` × `perTenantBatchSize`), so **one failing row or tenant
  cannot block an unrelated tenant** — verified by
  `dispatcher.integration.test.ts` "a failed allocation attempt (real Postgres
  error) never blocks a subsequent tenant" and the bounded-backoff recovery test.
- **Observable.** Persistent failure surfaces through `attempts` / `lastError` on
  the row **and** the Task 2.8 lag metrics (`withFailures`,
  `oldestUndispatchedAgeMs`, `OUTBOX_OLDEST_TOO_OLD` / `OUTBOX_BACKLOG_HIGH`
  threshold log lines naming the worst tenant).

Task 2.8 inspection of `dispatcher.ts` + `publisher.ts` confirmed no single
poison event can globally block unrelated tenants (owner decision 3 STOP
condition **not** triggered).

The BullMQ `dead-letter` **queue** (Task 2.3, for a BullMQ job that exhausts its
retries) is unrelated and unchanged.

---

## 8. F8 / F9 closure

**Structurally resolved in Task 2.6.** `packages/realtime-client/src/reducer.ts`'s
`ApplyDecision` type no longer has a `gap-needs-resync` variant at all;
`lastSeqByTopic`, `maxSeqGap`, `DEFAULT_MAX_SEQ_GAP` are deleted, not deprecated.
There is no `tenantHighWaterSeq − clientLastSeq` (or any per-topic `seq`-delta)
arithmetic in any path. Resync eligibility is **only** "scanned Stream cursor
below `XINFO STREAM`'s first retained entry".

- **F8** — `apps/realtime/src/resume.integration.test.ts`: normal cross-topic
  interleave + an unrelated-branch burst of thousands of events → **zero** false
  resync; the subset-subscribed client's scanned cursor still advances to ≈ the
  stream tail.
- **F9** — a reordered delivery (`stale` result) followed by an in-order event →
  no false gap; the scanned cursor advanced past the stale event.

Task 2.8's retention proofs 5–6 confirm the retention job produces exactly the
floor state (`XINFO STREAM` `recorded-first-entry-id`) that `GatewayHub.resume`'s
below-floor / within-retention branches key on.

---

## 9. Resolved open items (OI-P2)

| Item                                            | Resolution                                                                                                                                                                                                                                                                                                                                                     |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **OI-P2-1** — `seq` allocation                  | Durable `outbox_tenant_seq` counter table + `INSERT … ON CONFLICT DO UPDATE … RETURNING` (chosen over a `SEQUENCE` — not transactional on rollback). Per-tenant advisory-lock leader is the only allocator; stamp commits before any `XADD`; rows stamped in `(createdAt, id)` order; retry identity read back from the row (Task 2.4, ADR-0017 OI-P2-1 note). |
| **OI-P2-2** — relay placement                   | `apps/worker` loop (not the `apps/realtime` process) — the relay is a pure Redis consumer of the durable Stream, no Postgres dependency (Task 2.5).                                                                                                                                                                                                            |
| **OI-P2-3** — domain-module reuse               | Resolved by FC-3 — extract the minimum reusable layer into `@flower/backend`; `api` / `worker` / `scheduler` / `realtime` are separate processes each consuming it (Task 2.3).                                                                                                                                                                                 |
| **OI-P2-4** — Pub/Sub granularity               | Per-tenant `rt:live:{tenantId}` live channel (Task 2.5).                                                                                                                                                                                                                                                                                                       |
| **OI-P2-5** — durable server-side resume cursor | Not needed — client-held Stream cursor only; a durable server-side per-client cursor would add lifecycle / cleanup / cross-device ambiguity without improving correctness (Task 2.6).                                                                                                                                                                          |

---

## 10. Known limitations

- **HG-CI**: the local full workspace suite (33/33 turbo tasks) and the
  cumulative security review (no Critical/High/Medium) are done; the branch PR
  run (`verify` / `security` / `e2e` / `realtime`) is the last gate and is
  stamped once green. Integration is gated on all four jobs green.
- The worker `/metrics` outbox-lag snapshot runs two small aggregate queries per
  scrape (through `flower_dispatcher`). Acceptable for an internal metrics
  endpoint; if scrape frequency ever becomes a concern, cache with a short TTL.
- Retention uses the approximate (`~`) `XTRIM MINID` form in production (cheaper;
  may leave a few entries just past the floor) — the exact form is used in the
  deterministic integration tests. This is within ADR-0017 §5.
- Audit hash chain: columns exist, nothing writes them (OD-P2-1). The chain +
  verification job land in Phase 4 with the Z-Report chain (B7).
- Localization ships **verified reference data**, not a compliance guarantee
  (`GCC-FISCAL-REFERENCE.md`); no tax **calculation**; KSA onboarding stays GATED
  on ZATCA (Z-3 / Z-8 / ADR-0017-unrelated).

---

## 11. Completion checklist (owner decision 13)

| Condition                                                | State                                                                 |
| -------------------------------------------------------- | --------------------------------------------------------------------- |
| Retention genuinely implemented + tested (8 proofs)      | ✅ `apps/worker/src/stream-retention/` + compiled-runtime smoke (§4b) |
| Lag / failure observability exists                       | ✅ bounded aggregates + threshold logs                                |
| HG-OUTBOX wording matches the implementation             | ✅ §7                                                                 |
| Realtime CI job build-blocking + green                   | ⏳ job added (§2.8); green stamped from the PR run                    |
| Probes cover all Phase 2-core HTTP endpoints             | ✅ 2 localization reads + meta-test                                   |
| F8 / F9 structurally resolved                            | ✅ §8                                                                 |
| Every hard gate green                                    | ⏳ HG-CI pending the PR run; all others ✅                            |
| Cumulative security review — no open Critical / High     | ✅ no Critical / High / Medium (§4)                                   |
| This document accurately records evidence                | ✅                                                                    |
| PR CI green (`verify` / `security` / `e2e` / `realtime`) | ⏳ PR run                                                             |

After the PR run is green and the security review is clean: **STOP for owner
integration approval.** Do not merge automatically. Do not tag from an unmerged
branch. After owner-approved integration + push-to-main CI green on all four
jobs → annotated tag `phase-2-core-complete` on that commit; push; verify via the
GitHub API; **STOP**. Do not create `phase-2-complete`. Do not start Phase 3 or
the Phase-2 backlog.
