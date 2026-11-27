# R-1a — disabled-secrets authorization (amendment to R-1) — pack for independent security review

**Status: CANDIDATE, on a draft, review-only pull request. Not merged, not activated, not approved.** It needs (1) R-1 itself, which is also
unapproved, and (2) an independent security reviewer, who is **not yet named**. Nothing in this document is an approval, and a green CI run
would not be one either.

## 1. The problem (measured)

R-1 adds `SECRETS_PROVIDER=disabled`, a fail-closed vault (`DisabledCryptoProvider` throws `503 SECRETS_DISABLED`; nothing is ever stored).
In the R-1 candidate it was accepted in **every** `NODE_ENV`, including production, with no sign that anyone chose it deliberately. The policy
"only for the internal alpha" was held by the staging preflight and by approval wording, not by the application. A copied environment file or
a forgotten default could put a public deployment on the disabled vault without a single refusal.

## 2. The change (smallest that fails closed)

`SECRETS_PROVIDER=disabled` is refused at boot **in every `NODE_ENV`** unless **both** are set:

| Variable                         | Rule                                                                                                                                                                             |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SECRETS_DISABLED_AUTHORIZATION` | exactly `internal-alpha-only` (case-sensitive, no trimming, no truthy words)                                                                                                     |
| `SECRETS_DISABLED_UNTIL`         | a real `YYYY-MM-DD` calendar date, from today (UTC) to **at most 90 days** ahead; a timestamp, a US/short date, an impossible date or an empty value is refused, never truncated |

- With any other provider, **either variable is refused** (no latent authorization that a later edit could switch on).
- An empty value counts as unset (Compose passes `${VAR:-}`).
- The check is one function, `assertSecretsDisabledAuthorization(cfg, now)` in `apps/api/src/config/env.ts`, called by `loadConfig` **and** again
  by the one place a provider is chosen, `createCryptoProvider` in `secrets.module.ts` (two independent layers). An expired authorization therefore
  stops the next restart. The disabled vault is announced once at startup with its expiry date.
- Refusals name the variable in the message body and **never echo the supplied value**. Because the shared logger keeps only a templated first line
  of an error message, the two new refusals carry a fixed first-line reason (`Invalid environment (secrets vault disabled without a valid
internal-alpha-only authorization):`).
- Infra: `preflight.mjs` mirrors the rules (the env file is refused before the stack starts); the Compose file passes both variables through;
  `check-release.mjs` refuses a Compose file that drops them **or hard-codes them**; `.env.example` ships `CHANGE_ME` placeholders so the
  authorization is a deliberate act; the smoke, rollback rehearsal and CI env builders carry them; two CI steps run the new checks.
- **Unchanged:** `dev` is still refused in production (G16); `kms` is still unwired and still stops at "no managed KMS crypto provider is wired yet
  (production is gated — G16)"; the vault routes (platform realm only) are untouched; no tenant-realm code, no permission, no migration, no RLS.

## 3. Evidence (local; the GitHub CI result is recorded on the pull request, not in this file)

| Check                                                                                                                                                                                                                                                                                                                                           | Result                                                                                                                                                                                                                                                                                                                           |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API unit tests (`src/config`, `secrets-module-authorization`, `disabled-crypto-provider`)                                                                                                                                                                                                                                                       | 4 files, **33 passed**                                                                                                                                                                                                                                                                                                           |
| Exhaustive matrix: 3 `NODE_ENV` × 4 providers × 6 authorization values × 11 expiry values against an independent oracle                                                                                                                                                                                                                         | passes                                                                                                                                                                                                                                                                                                                           |
| Time zone: the UTC-day rule is tested with the zone **forced** to UTC+14 and UTC−12, so a UTC CI runner cannot pass vacuously                                                                                                                                                                                                                   | passes; the "local-time" mutant is caught with the machine zone also forced to UTC                                                                                                                                                                                                                                               |
| Real logger line (`createRootLogger`) carries the reason; the supplied value is never in a refusal                                                                                                                                                                                                                                              | passes                                                                                                                                                                                                                                                                                                                           |
| Integration proof, real `AppModule` + Postgres + Redis (5 tests): unauthorized, expired, over-long and wrong-value boots are refused; the authorized control boots; vault routes stay `503 SECRETS_DISABLED`; no row, no plaintext in the database; a pre-existing credential row cannot be opened; a cash + card-terminal sale still completes | **5/5**                                                                                                                                                                                                                                                                                                                          |
| **Compiled `dist/main.js` boot probe**, 12 production environments (the R-1 hole, no date, wrong value, expired, 91 days, timestamp, development, kms + latent authorization, dev provider, kms + dev master key, authorized, kms + real key)                                                                                                   | **12/12** as expected; `kms` + real key stops at the G16 message                                                                                                                                                                                                                                                                 |
| Regression: `src/config`, `src/modules/secrets`, `src/probes` (cross-tenant + cross-branch), 15 structural suites                                                                                                                                                                                                                               | **23 files / 761 passed**                                                                                                                                                                                                                                                                                                        |
| Typecheck (`tsc --noEmit`), ESLint on the changed folders, Prettier on every changed file                                                                                                                                                                                                                                                       | clean                                                                                                                                                                                                                                                                                                                            |
| Mutation, API (23-mutant matrix + follow-ups)                                                                                                                                                                                                                                                                                                   | **30 caught**, 2 survivors. The survivors are intentional: removing only the `loadConfig` call, or only the factory call, still refuses because the other layer does; removing **both** is caught. (One matrix entry, the unanchored date regex, was skipped by a quoting fault in my script and was re-run separately: caught.) |
| Preflight (`node --test infra/staging/preflight-secrets.test.mjs`)                                                                                                                                                                                                                                                                              | **12 tests**, 11 mutants, 11 caught; every refusal is asserted for its reason; values are never echoed                                                                                                                                                                                                                           |
| Compose replay of the CI steps (`config -q`, `check-release`, four tampered Compose files)                                                                                                                                                                                                                                                      | 11/11                                                                                                                                                                                                                                                                                                                            |

**Re-verified after stacking on the staging recovery pull request** (which makes the preflight stricter about application images and backup
settings): the R-1a preflight test failed on first contact, because its fixture used tag-only images (`flower/api:alpha`) that the stricter
preflight refuses. The fixture now uses well-formed digest references; **no assertion was changed**. On the stacked tree: 12/12 tests, 11/11
preflight mutants caught (one mutant's target text had to follow a prettier reflow), and the `staging-config` job's steps replayed 10/10.

## 4. What this does and does not give you — please read

- It is a **speed bump against accidental use**, not a defence against a deliberate operator who controls the environment file: someone who can set
  the two variables can set them. The vault stays fail-closed either way; the guard makes the choice explicit, dated and visible.
- The time box is judged **at start**. A running process is not stopped when the date passes; the **next restart** is. A staging stack that is
  never restarted can outlive its authorization. (A periodic runtime re-check was considered and left out as larger than needed.)
- Every other environment refusal still logs only `Invalid environment:` (the logger drops the detail and turns long variable names into
  `<token>`). That is existing behaviour of the owner-approved logging control and was **not** changed. Reviewer: decide whether to generalize
  the first-line reason to the other refusals.
- Alternatives considered and **not** chosen as larger: refusing boot when an ACTIVE `provider_credential` row exists; a separate feature flag
  plus a signed release record; moving the authorization out of the environment.

## 5. Tenant isolation

No tenant-realm code, route, permission or table is touched. The cross-tenant and cross-branch probe suites are part of the regression above and
pass. The disabled vault can neither hold nor reveal a secret for any tenant.

## 6. Questions for the reviewer

1. Is 90 days the right cap, and is `today..today+90` (UTC, inclusive) the right window?
2. Is "judged at start" enough, or must a running process re-check (and stop)?
3. Should the first-line reason be generalized to the other `EnvValidationError` refusals?
4. Is an environment-variable authorization acceptable, given the speed-bump limit in section 4?
5. Should `dev` and `disabled` ever be allowed to coexist with a non-empty `provider_credential` table?

## 7. How to review and (later, if approved) apply

- The pull request has two commits, reviewable separately: R-1 (the five files of the PR #42 artefact `R1-secrets-disabled-provider.patch`,
  unchanged, plus one added proof test) and R-1a (this amendment). **Do not merge, deploy or enable.**
- It is stacked on the staging recovery pull request, which is itself stacked on the full-stack CI rehearsal; both bases carry unmerged
  prerequisites (#42, #43, #44, #45, #47, #48, #49, #51, #52, #53), so it can only merge after them.
- To undo: close the pull request, or revert the two commits. The change contains no migration and no data change.
- The reviewer and the owner both have to approve before any merge. CI must run on the real PR and be read, not assumed.
