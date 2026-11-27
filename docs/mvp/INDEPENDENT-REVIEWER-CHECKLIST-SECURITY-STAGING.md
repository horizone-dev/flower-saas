# Independent reviewer checklist: R-1 / R-1a and the staging recovery work (2026-11-27)

**Status: NOT APPROVED.** This is a checklist for an independent security and staging reviewer who is **not yet named**. A green CI run is evidence, not
approval. The author of this change (an AI assistant working with the owner) cannot be the reviewer, and nothing here may be read as an approval of R-1,
R-1a, the PostgreSQL pin, a backup design or a host. The accounting amendments A1 to A4 are a separate decision for the accountant and are **not** part
of this review and **not** activated.

## How to use this

- Two pull requests, reviewed in this order. The staging recovery pull request is the base of the secrets pull request, and both sit on the
  full-stack CI rehearsal (PR #55), which carries ten unmerged prerequisites (#42, #43, #44, #45, #47, #48, #49, #51, #52, #53).
- The secrets pull request has **two commits** that can be read separately: R-1 (the PR #42 artefact plus one proof test) and R-1a (the amendment).
- For every item, record **Accept**, **Accept with condition** or **Reject**, and one line of reason. Items tagged **(C)** are answered by reading code,
  **(R)** by running a command, **(H)** only on a real host, where nothing exists yet.
- Read first: `R1-SECURITY-REVIEW-PACK.md`, `R1A-AMENDMENT-REVIEW-PACK.md`, `STAGING-READINESS-MATRIX.md` (sections 0 and 2.12) and
  `STAGING-DEPLOYMENT-CHECKLIST.md` (sections 2, 4a, 5 and 9).
- CI results for each pull request are recorded **on the pull request**, not in this file.

## 1. R-1 / R-1a fail-closed policy

- [ ] **(R) R-1 is the approved artefact.** The five files of `docs/decisions/proposed-migrations/patches/R1-secrets-disabled-provider.patch` (PR #42) apply
      to the base and give exactly the R-1 commit's tree, except for one added file, `r1-disabled-vault.integration.test.ts`. Confirm the added file only
      tests and changes no production code.
- [ ] **(C) The disabled provider can neither store nor reveal.** `DisabledCryptoProvider.encrypt` and `.decrypt` always throw `503 SECRETS_DISABLED`;
      create is refused **before** any database write; the proof test scans every column for the plaintext.
- [ ] **(R) The boot refusal matrix.** `SECRETS_PROVIDER=disabled` is refused in every `NODE_ENV` unless `SECRETS_DISABLED_AUTHORIZATION` is exactly
      `internal-alpha-only` and `SECRETS_DISABLED_UNTIL` is a real `YYYY-MM-DD` from today to today plus 90 days (UTC). Wrong value, expired, 91 days, a
      timestamp, a US date, an impossible date and an empty value are refused. With `dev` or `kms`, either variable is refused (no latent authorization).
      Run `src/config/secrets-disabled-authorization.test.ts` and `node --test infra/staging/preflight-secrets.test.mjs`.
- [ ] **(C) Two independent layers.** `assertSecretsDisabledAuthorization` runs in `loadConfig` and again in `createCryptoProvider`. Decide whether two
      layers are enough. The author's mutation run shows removing one layer still refuses and removing both is caught.
- [ ] **(C) It is a speed bump, not a defence.** Anyone who controls the environment file can set both variables. Decide whether that is acceptable for
      an internal alpha, and which host control compensates (file mode 600, operator-only access).
- [ ] **(C) The time box is judged at start.** A running process is not stopped when the date passes; the next restart is. Decide whether a periodic
      runtime re-check is required before the alpha.
- [ ] **(C) The 90-day cap and the UTC window** (today to today plus 90, inclusive) are acceptable.
- [ ] **(R) A refusal never echoes the supplied value**, and the one-line reason reaches the log (the shared logger keeps only a templated first line).
- [ ] **(C) Unchanged guards.** `dev` is still refused in production; `kms` is still unwired and still aborts at boot; the vault routes stay in the
      platform realm only (`platform:secrets:manage` with step-up); no tenant-realm code, permission, migration or RLS policy is touched.
- [ ] **(R) Tenant and branch isolation.** The cross-tenant and cross-branch probe suites pass in CI. Confirm they ran and were not skipped.
- [ ] **(C) Known limits, to be accepted by the owner in writing.** No provider credential can be stored (no payment gateway, WhatsApp, SMS or AI key);
      it is **not** a KMS, so CLAUDE.md rules 26 and 27 are not delivered, only not exercised; a refused create or rotate leaves **no audit row**; `503`
      may invite client retries; `DevCryptoProvider` is still constructed under `disabled` but never returned (a mutant covers any exposure).
- [ ] **Decision:** approve R-1 for the internal alpha only? Approve R-1a? Both are reviewed and merged together, as one pull request.

## 2. Secrets handling and production-mode startup

- [ ] **(R) Production-mode startup.** With `NODE_ENV=production`: the `dev` provider, the dev JWT secret, wildcard or localhost CORS and a missing
      `DATABASE_URL` are all refused. The author kept a 12-environment boot probe of the compiled `dist/main.js` outside the repository; ask for it or
      rerun the unit matrix.
- [ ] **(C) Infrastructure secrets are not in the vault.** `AUTH_JWT_SECRET`, the database, Redis and MinIO passwords live in
      `infra/staging/.env.staging` on the host. Confirm the preflight refuses placeholders, duplicates, short values (24 or more characters required) and
      an env file readable by group or others.
- [ ] **(C) The authorization is a deliberate act.** `.env.example` ships `CHANGE_ME` placeholders for both variables; Compose passes them as
      `${VAR:-}`; `check-release.mjs` refuses a Compose file that drops them **or hard-codes them**.
- [ ] **(H) No secret in any log.** Acceptance gate A9 (logs checked after the journeys) can only run on the host.
- [ ] **(H) Rotation.** Rotating `AUTH_JWT_SECRET` signs everyone out; rotating a database password needs the `roles` job. Neither is tested.
- [ ] **Decision:** who owns the host-level handling and rotation of the infrastructure secrets?

## 3. PostgreSQL version risk

- [ ] **(C) One image, one pin.** `infra/staging/postgres-image.pin` holds `postgres:17.11@sha256:ff87138949ad9a46f32ff23bd6852b52ce024a13dffe9b4087be98292cdd3b4f`
      for **both** the `postgres` and `backup` services; the preflight requires equality with the pin file and `check-release.mjs` refuses split images.
- [ ] **(R) Verify the risk statement yourself.** The checklist (section 2) records that 17.11 is **not** the current minor (17.12 was released on
      2026-11-12) and that 17.12 fixes about 48 CVE-identified issues, including **two row-level-security fixes** (`ON CONFLICT` evaluating user
      quals before RLS policies; `DROP OWNED BY` removing restrictive RLS policies). Those facts were taken from postgresql.org on 2026-11-27; re-check
      them against the release notes rather than trusting them.
- [ ] **(C) RLS reachability.** This system's tenant isolation rests on RLS (CLAUDE.md rule 7). Decide whether the two RLS fixes make 17.11 unacceptable
      even for an internal alpha. The author did not assess which application queries touch those code paths.
- [ ] **(C) Why not 17.12.** On 17.12 the frozen report performance tests fail (8 to 10 tests in 3 files, Finding A, evidence in PR #50). PR #56 is the
      candidate rewrite; it is **draft, blocked and not part of this review**. The owner deferred that decision on 2026-11-27.
- [ ] **Conditions recommended by the author, each yours to accept:** staging only; the database unreachable from outside the Compose network (the
      check asserts 5432 is not published); `REINDEX` the two GIN trigram indexes on `product."nameEn"` and `product."nameAr"` before any search-quality
      check; time-box the decision (re-decide at the next minor or before any user outside the internal alpha).
- [ ] **(C) A digest freezes the OS layer.** It never receives Debian fixes. Decide how often the digest is refreshed and by whom.
- [ ] **Decision:** accept 17.11 for the alpha, switch the pin to 17.12, or require the frozen-SQL decision first?

## 4. Database roles, backups and restore

- [ ] **(R) The four cluster roles** created by `ops/roles-bootstrap.sql` match the migrations (`phase_1_identity_tenancy_rbac`,
      `outbox_dispatcher_least_privilege`): `flower_app` NOSUPERUSER NOBYPASSRLS; `flower_platform` BYPASSRLS; `flower_migrate` NOBYPASSRLS CREATEDB;
      `flower_dispatcher` BYPASSRLS. All NOLOGIN, no password in the file. The script is idempotent and **refuses** an existing role whose attributes
      differ. Confirm the application role can never bypass RLS.
- [ ] **(C) Role passwords** are set afterwards by `infra/migrate/provision-db-roles.mjs`, which this change does not touch.
- [ ] **(C) `backup-run.sh`.** A custom-format dump is verified with `pg_restore --list`, must exceed a size floor, gets a SHA-256 sidecar, and leaves no
      partial file on failure. The password never appears in the output.
- [ ] **(C) `backup-prune.sh` and the scheduler.** Retention keeps the newest `BACKUP_KEEP` **verified scheduled** dumps (default 14, minimum 3); it never
      touches pre-migrate, partial, unverified or foreign files and runs **only after a successful backup**, so a failing backup cannot erode history.
- [ ] **(C) The scheduler service** uses the same image as the database and reports unhealthy when `.last-backup-ok` is older than 26 hours.
- [ ] **(C) The scheduler holds the PostgreSQL superuser password**, exactly like the existing `backup` job. Decide whether a dedicated backup role is
      required.
- [ ] **(R) `restore-offhost.sh`.** It requires the sidecar, refuses an existing database, creates the roles first, uses `--exit-on-error`, and runs
      post-checks.
- [ ] **(H) Not proven:** a restore on a real second machine, transfer or encryption of a dump, restore time at real data volume, and the disk the
      retention needs. A dump on the database host is **not** a backup against host loss (gap G8), and no off-host destination exists (gap G11).
- [ ] **(C) Backups contain tenant data.** Decide where they live, who can read them, and whether they are encrypted at rest.
- [ ] **Decision on MinIO:** it is in no backup (gap G9). The author proposes excluding it for the alpha because no first-party code writes to it.

## 5. Redis session invalidation

- [ ] **(C) Why it exists.** Sessions live in Redis, not in the backup. After a database rollback or restore a token from the "new" era would still be
      accepted by the old software (measured: HTTP 200 without the flush, 401 with it).
- [ ] **(R) The order and the guard.** Stop the API, restore the database, run `flush-redis-sessions.sh`, start the previous API. The script refuses while
      the API runs or cannot be found, requires `FLUSHALL` to be acknowledged, requires `DBSIZE` 0 afterwards, and prints counts only.
- [ ] **(C) Side effect.** `FLUSHALL` also drops rate limits and idempotency keys (gap G12). Decide whether rolling back with sales stopped is an
      acceptable rule, and what happens to an in-flight request that is retried after the flush.
- [ ] **(H) Realtime.** CLAUDE.md rule 30 says session revocation drops sockets. This change does **not** test that a `FLUSHALL` drops live realtime
      connections. Verify on a running stack.
- [ ] **(C) Redis password.** `redis-cli -a "$REDIS_PASSWORD"` runs inside the container. Decide whether that is acceptable.

## 6. TLS, image pinning, logs and readiness

- [ ] **(C) TLS.** Caddy obtains certificates automatically (ACME) for three hosts and redirects HTTP to HTTPS; HSTS is one year with
      `includeSubDomains`; request bodies are capped at 2 MB. Decide whether that HSTS setting is acceptable for the alpha domain.
- [ ] **(C) Host separation.** The platform realm returns 404 on the shop-facing host; the operator host serves only `/v1/platform/*` and only from
      `ADMIN_CIDR` (`remote_ip`), otherwise 403.
- [ ] **(H) `ADMIN_CIDR` is only as good as the address Caddy sees** (gap G4). A proxy, NAT or CDN in front would make it meaningless. Verify on the host.
- [ ] **(R) Image pinning.** The preflight refuses a tag for the API, POS, owner and migrate images outside `--local` (accepts `name@sha256:` or an image
      id); `redis` and `caddy` are pinned by digest in Compose and `check-release.mjs` refuses a tag. **Release images do not exist yet** (gap G1) and no
      registry is chosen (gap G3).
- [ ] **(C) The rollback set.** A `docker image prune` could delete it. Confirm the rule in the checklist is enough.
- [ ] **(R) Logs.** `json-file` 10 MB by 5 files on every service, enforced by `check-release.mjs` and re-checked on running containers by
      `host-readiness.sh`. Docker logs are not an audit store.
- [ ] **(R) Readiness.** `host-readiness.sh` is read-only and fails closed: services and health, `/readyz` through `docker compose exec` (it is **not**
      routed from outside, gap G13), backup age, immutable image references, rotated logs, disk, TLS expiry on the three hosts, and clock sync.
      Run `bash infra/staging/ops/host-readiness.test.sh` (36 checks).
- [ ] **(C) No alerting exists** (gap G14). The script is the runnable minimum (cron plus mail on a non-zero exit); no channel was invented.

## 7. Required staging host configuration (nothing of this exists yet)

- [ ] A host, a region and a named operator (D-HOST); DNS records for the three hosts; ports 80 and 443 reachable for ACME.
- [ ] Firewall: port 22 restricted to the operator, 80 and 443 open, **nothing else** (5432, 6379 and 9000 must not be published).
- [ ] SSH keys only; unattended security updates; **time synchronisation** (TOTP codes and token expiry depend on it).
- [ ] `infra/staging/.env.staging` with mode 600, owner-only, filled in by the operator; `ADMIN_CIDR` is the operator network, never a wildcard.
- [ ] **A reboot test** (gap G17): after `sudo reboot` the stack must come back to `/readyz` all `ok` with no manual step. Docker restarts the
      `unless-stopped` services but does not honour `depends_on` after a reboot, and the one-shot jobs do not re-run. This was never tested.
- [ ] **Sizing**: disk for PostgreSQL, dumps, Redis and logs. **Nothing has been measured; do not assume it.**
- [ ] An off-host backup destination, a transfer and encryption method, and a **restore drill** on a second machine.
- [ ] A monitoring and alert owner who runs `host-readiness.sh` on a schedule.

## 8. What the author did and did not prove

- Proven locally and recorded in the pull requests: unit, integration and mutation evidence for R-1 and R-1a; 42, 11, 56 and 36 checks for the recovery
  scripts, the scheduler service, the Compose and preflight replay and host readiness; 18 and 19 mutants caught for the recovery scripts and the
  readiness script. Mutants were counted as caught only when the run finished and the **intended** check failed.
- **Not** proven: anything on a real host, a real second machine, a reboot, real data volume, TLS or DNS from outside, that an alert reaches a person,
  or that the images in use are release images (none exist).

## 9. Sign-off

| Area                                   | Decision (Accept / Accept with condition / Reject) | Conditions | Reviewer | Date |
| -------------------------------------- | -------------------------------------------------- | ---------- | -------- | ---- |
| 1. R-1 / R-1a policy                   |                                                    |            |          |      |
| 2. Secrets and production-mode startup |                                                    |            |          |      |
| 3. PostgreSQL version risk             |                                                    |            |          |      |
| 4. Roles, backups and restore          |                                                    |            |          |      |
| 5. Redis session invalidation          |                                                    |            |          |      |
| 6. TLS, images, logs and readiness     |                                                    |            |          |      |
| 7. Staging host configuration          |                                                    |            |          |      |

**Nothing is approved until a named independent reviewer fills in this table and the owner records the decision.** CI does not approve.
