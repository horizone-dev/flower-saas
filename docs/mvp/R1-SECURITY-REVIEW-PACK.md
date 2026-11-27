# R-1 security review pack: `SECRETS_PROVIDER=disabled` (2026-11-27)

**Status: PREPARED FOR INDEPENDENT SECURITY REVIEW. NOT APPROVED. NOT APPLIED, MERGED OR ACTIVATED.** No reviewer is named yet (gate E5). The patch stays a hash-pinned file under `docs/decisions/proposed-migrations/patches/`; the API images used below are local rehearsal images. This pack adds evidence and limits; it does not change the patch.

## 1. Decision requested

Approve the patch for the **internal alpha only**, with a real KMS remaining a separate decision that must be made before any provider credential is stored. Wording already prepared in `DECEMBER-APPROVAL-PACKAGES-2026-11.md` §2:

> "Approve `R1-secrets-disabled-provider.patch` (set hash `a9607804…faa826f2`) for the internal alpha only; real KMS remains a separate decision before any provider credential is stored."

**Why it is a hard prerequisite for staging (measured 2026-11-27):** the committed API image (the #55 tip) accepts `SECRETS_PROVIDER` `dev` or `kms` only. `dev` is refused when `NODE_ENV=production`; `kms` passes the environment check but the process aborts while building the secrets module (`SECRETS_PROVIDER=kms: no managed KMS crypto provider is wired yet (production is gated — G16)`, exit code 1). So **without R-1 the API cannot start in production mode at all**, and `infra/staging/preflight.mjs` demands `disabled`.

## 2. The change

| Item             | Value                                                                                                                                                                                                                                                                                   |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Patch file       | `R1-secrets-disabled-provider.patch`, sha256 `1d6d564dc927c3152d91a46a8f54eb4360c1c5548f00f8f81ddbbae0d1285245` (re-checked today against `SHA256SUMS`; recorded set pin `a9607804…faa826f2`)                                                                                           |
| Proof test       | `R1-disabled-vault.integration.test.ts.txt`, file sha256 (LF) `98424dddda2d85f1e031113f62366b3891d98799980beb5ebeee8de0d96df412`; recorded set hash `0a7f975d…99ba44` (type-corrected 2026-11-18, 14 assertions in 4 tests unchanged)                                                   |
| Production files | 3: `apps/api/src/config/env.ts` (+5 −2), `modules/secrets/crypto-provider.ts` (+24), `modules/secrets/secrets.module.ts` (+7 −1); plus two test files, `config/env.test.ts` (+22) and the new `disabled-crypto-provider.test.ts` (+32)                                                  |
| What it does     | adds the value `disabled` to `SECRETS_PROVIDER`; adds `DisabledCryptoProvider`, whose `encrypt` and `decrypt` always throw `503 SECRETS_DISABLED`; the module factory returns it for `disabled`; the production master-key check is skipped for `disabled` only (the key is never used) |
| What it does not | no schema, no migration, no permission key, no route, no change to any tenant-scoped code, no new dependency                                                                                                                                                                            |
| Source equality  | the R-1 source in the tree the rehearsal image was built from (`fwt\stack-r1`) is **byte-identical, file by file, to the pinned patch's result** (5 files compared by blob id)                                                                                                          |

## 3. What the vault does when disabled (code reading + the proof test)

| Operation (platform realm only, `platform:secrets:manage`, step-up) | Result with `disabled`                                                                                                                                          |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Create a credential                                                 | `503 SECRETS_DISABLED`, raised **before** any database write (the service seals first); no row; the plaintext appears in **no column of any table** (full scan) |
| Rotate an existing credential                                       | `503` after the existence check; an unknown id is `404`                                                                                                         |
| Read one credential                                                 | `503` (it must decrypt to build the mask), so a row created before the vault was disabled **cannot be opened**                                                  |
| List credentials                                                    | `200`, metadata and the generic mask only; no decryption                                                                                                        |
| Revoke a credential                                                 | works (no decryption), so an old credential can still be revoked                                                                                                |
| Anything that needs no secret: cash and card-terminal split sale    | unaffected (the proof test completes one; card is a recorded local tender)                                                                                      |

Only `SecretsService` consumes the crypto provider (through the `CRYPTO_PROVIDER` token). Nothing else injects `DevCryptoProvider` or the provider directly. No concrete payment, WhatsApp, SMS or AI adapter exists in `apps/api` (only the payment port and an empty registry), and no environment variable carries a provider secret, so **no feature that needs a secret exists at this tip** to be blocked.

## 4. Fail-closed startup, measured on the real compiled code

`loadConfig` called inside throw-away containers (`--network none`) from two images: the R-1 rehearsal image and the committed #55 image (`rc/r1-matrix.txt`).

| Case (production unless stated)               | R-1 image                                                                          | Committed image (no R-1)       |
| --------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------ |
| `disabled`                                    | **accepted**                                                                       | refused (not an allowed value) |
| `disabled` with the dev-default master key    | accepted (the key is unused)                                                       | refused                        |
| `dev`                                         | refused (`must not be used in production`)                                         | refused                        |
| provider **unset** (default is `dev`)         | refused                                                                            | refused                        |
| `kms` with the dev-default master key         | refused (`SECRETS_MASTER_KEY: the dev default…`)                                   | refused                        |
| `kms` with a real master key                  | accepted by the environment check; **boot aborts, exit 1** (module factory throws) | accepted; boot aborts          |
| `Disabled` (wrong case), `none`, empty string | refused (allowed: `dev`, `kms`, `disabled`)                                        | refused                        |
| `disabled` with a localhost `CORS_ORIGINS`    | refused (CORS rule still applies)                                                  | refused (value not allowed)    |
| `disabled` with the dev `AUTH_JWT_SECRET`     | refused (JWT rule still applies)                                                   | refused (value not allowed)    |
| `disabled` with no `DATABASE_URL`             | refused                                                                            | refused (value not allowed)    |
| **`NODE_ENV=development` with `disabled`**    | **accepted**                                                                       | refused                        |

Real process start of the R-1 image, production, no network: `kms` exits 1 with the Nest error above; `disabled` constructs every module (the `SecretsController` routes are mapped) and then waits on the unreachable database and Redis, as it should.

## 5. "Allowed only under the approved internal-alpha policy": what is and is not enforced

**The code does not enforce a policy.** `disabled` is accepted in every `NODE_ENV` (last row above). That is safe by construction, because the mode can only refuse, never store or reveal. The policy is held by:

1. **The staging preflight** (`preflight.mjs`): `SECRETS_PROVIDER` must be `disabled` and `dev` is refused (24/24 gate-matrix cases, rehearsal evidence).
2. **The production environment rules**, all still active under `disabled`: no dev JWT secret, `DATABASE_URL` required, no wildcard or localhost CORS.
3. **The approval wording** (internal alpha only; KMS before any credential).

Options the reviewer may require (**none is applied**; each is small): (a) log the active provider at startup and expose it in `/readyz` so an operator and a monitor can see `disabled`; (b) refuse `disabled` when an `ACTIVE` `provider_credential` row exists, so a deployment cannot silently orphan live credentials; (c) refuse `disabled` outside an explicit allow-list of environments. Each changes the patch and therefore its pinned hash.

## 6. Limitations of disabled secrets storage (state these to the owner)

- **No provider credential can be stored**: no payment gateway, WhatsApp BSP, SMS or AI key. Online card payments, webhooks and settlements stay off; card is a **recorded terminal tender** only. Customer-facing online ordering and payment are out of the alpha.
- **It is not a KMS.** CLAUDE.md rules 26–27 (envelope encryption, per-tenant DEK, masked, versioned, revocable) are **not delivered**; they are simply not exercised. `kms` has no implementation (boot aborts). A real provider is a separate decision and phase.
- **Existing sealed rows cannot be read** (`503`); `list` and `revoke` still work. None is expected in a fresh staging database.
- **Infrastructure secrets are not in the vault.** `AUTH_JWT_SECRET`, database, Redis and MinIO passwords live in `infra/staging/.env.staging` on the host. Their protection is host hygiene (file mode 600, owner-only, password manager) plus the preflight rules (24+ characters, distinct, no placeholder). Rotating `AUTH_JWT_SECRET` signs everyone out; rotating a database password needs the `roles` job to run (expected, **not tested**).
- **A refused attempt is not audited**: the error is raised before the repository runs, and the repository writes the audit row in its own transaction for create, rotate and revoke. By code reading; not asserted by a test.
- **`DevCryptoProvider` is still constructed** (the module factory receives it) and derives an in-memory key from the master key, but it is never returned for `disabled`. Mutant M8 shows the test suite catches any exposure.
- `503` suggests a retry to some clients; any operator tooling that retries on `503` would retry forever. No such tooling exists at this tip.

## 7. Evidence (all on 2026-11-27, scratch worktrees, nothing pushed)

| Evidence                                                                                                                                                                                                                                                                                                 | Result                                                                                       |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Patch hash against `SHA256SUMS`; applies to `origin/main` `ea56cff` and to the #55 tip `174c6ec` (temporary index)                                                                                                                                                                                       | OK; applies                                                                                  |
| Unit + env tests (`env.test.ts`, `disabled-crypto-provider.test.ts`) on clean `main` + R-1                                                                                                                                                                                                               | **15 / 15**                                                                                  |
| Proof test (real PostgreSQL + Redis, real guard pipeline, platform token with step-up)                                                                                                                                                                                                                   | **4 / 4**                                                                                    |
| **Mutation matrix**: 9 one-line mutants of the production code (seal instead of refuse; decrypt returns empty; error code renamed; dev allowed in production; master-key check skipped for all providers; `disabled` removed; check inverted; module wires the dev provider; row written before sealing) | **9 / 9 caught**; baselines green first; working tree clean afterwards (`rc/r1-mutants.out`) |
| Startup matrix on the real compiled `loadConfig` (13 cases × 2 images) and real process start                                                                                                                                                                                                            | §4                                                                                           |
| Vault and isolation regression with R-1 applied (existing vault tests, config, two probe suites, 15 structural pin suites)                                                                                                                                                                               | §8                                                                                           |
| Staging preflight gate matrix with `SECRETS_PROVIDER` rules                                                                                                                                                                                                                                              | 24 / 24 (the `dev` case is refused: `SECRETS_PROVIDER must be disabled`)                     |
| Rollback rehearsal with the R-1 image in production mode                                                                                                                                                                                                                                                 | 142 passed, 0 failed, 1 explained deviation; readiness all `ok` in three deploy phases       |

## 8. Isolation and vault regression with R-1 applied

On a clean scratch worktree of `origin/main` `ea56cff` with the pinned patch and proof test applied, one run of: the whole `modules/secrets` directory (the existing dev-vault integration tests plus the two R-1 files), `src/config`, the two isolation suites in `src/probes` (cross-tenant and branch isolation) and all 15 structural pin suites: **21 files, 742 tests passed, 0 failed** (112 s). The patch touches no tenant-scoped code, so this is a regression check, not a new isolation proof: the cross-tenant and branch probes are unchanged and still green with R-1 applied.

## 9. Not proven

- Nothing ran on a staging host; the images are rehearsal images built from the uncommitted candidate, not release images.
- Log redaction for this path (the proof test asserts the response body and every database column, not the log stream). Acceptance gate A9 checks the logs after the journeys, on the host.
- A KMS provider, rotation, or any provider credential flow (none exists).
- The proof test needs the `realClock` option of the sale-world helper that only #43 carries; on bare `main` it fails `tsc` (TS2554) though vitest passes. R-1's PR therefore stacks on #43 (step 9 of `RELEASE-CANDIDATE-INTEGRATION-ORDER.md`).

## 10. Questions for the reviewer

1. Is the approval wording enough, or is a code-level policy gate (§5 options a–c) required before staging?
2. Is the in-memory construction of the dev provider under `disabled` acceptable, or should the factory build it only for `dev`?
3. Is it acceptable that a refused create or rotate leaves no audit row?
4. Is `503` the right status for a permanently disabled capability (a `501` or `409` would not invite retries)? Changing it changes the pinned patch and the proof test.
5. Who owns the host-level handling of the infrastructure secrets in §6, and how are they rotated?

## 11. Rollback

Revert the PR. No data, schema or permission is touched. Any environment that sets `SECRETS_PROVIDER=disabled` then fails to start on the validation error, which is the intended fail-closed behaviour.
