# picomatch ReDoS advisory (GHSA-fc5q-39xc-vjpf) — risk assessment and exception proposal

**Status: PROPOSAL — nothing here is applied.** No scanner configuration, override or dependency was changed by this document. Prepared 2026-11-18 for owner and independent security-reviewer decision.

## 1. The advisory (as published, not paraphrased into a fix)

| Field           | Value                                                                                                                                                                                                                                            |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| ID              | GHSA-fc5q-39xc-vjpf (osv.dev alias)                                                                                                                                                                                                              |
| Severity        | High, CVSS 3.1 `AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:H` (8.7 as reported by osv-scanner)                                                                                                                                                            |
| Weakness        | CWE-1333 (inefficient regular expression complexity)                                                                                                                                                                                             |
| Published       | 2026-10-19                                                                                                                                                                                                                                       |
| Affected        | `picomatch <= 4.0.7`                                                                                                                                                                                                                             |
| Patched version | **none listed**                                                                                                                                                                                                                                  |
| Mechanism       | An attacker who can supply the glob **pattern** (for example `+(*)` or `+(*a)`) makes `analyzeRepeatedExtglob` in `lib/parse.js` skip the check, causing exponential backtracking on a short crafted string and blocking the Node.js event loop. |

Registry check (2026-11-18, `npm view picomatch`): latest release is **4.0.7** (published 2026-08-24). No newer release exists, so there is **no version to upgrade to**; none is invented here.

## 2. Exact dependency path in this repository

The lockfile holds one picomatch, `4.0.7`. `pnpm why picomatch -r` shows only:

```
picomatch@4.0.7
└─ fdir@6.5.0 └─ tinyglobby@0.2.17
     ├─ @typescript-eslint/typescript-estree@8.69.0 → typescript-eslint@8.69.0 → @flower/config (lint configuration package)
     └─ vite@8.2.4 → @vitest/mocker → vitest@4.1.12 → devDependency of every workspace package
```

- Every consumer is **tooling**: ESLint (`typescript-eslint`) and the test runner (`vitest`/`vite`).
- `@flower/config` is listed as a **`devDependency`** of every app and package (verified in all 21 `package.json` files that reference it).
- No application source imports picomatch (`grep` over `apps/*/src` and `packages/*/src`: no import; the only mention is a comment in the ESLint rule `dependency-boundaries.js`).

## 3. Runtime exposure

| Surface                                                                | Finding                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API / worker / scheduler / realtime production image (`deploy --prod`) | `pnpm --filter @flower/api deploy --prod --legacy <dir>` → **0** picomatch directories, no `tinyglobby`, `fdir`, `vite`, `vitest` or `typescript-eslint`.                                                                                                                                                                                                                                                                                                                               |
| Web apps                                                               | Next.js ships its **own vendored** `next/dist/compiled/picomatch` (not a lockfile entry, so osv-scanner does not see it and this advisory is **not evidenced** against it either way). Its runtime uses are `match-remote-pattern` / `match-local-pattern`, which match patterns from `next.config` against request URLs; the four apps configure **no** `remotePatterns` / `localPatterns`. The attack needs an attacker-controlled _pattern_; here patterns are developer-controlled. |
| CI / developer machines                                                | picomatch runs inside ESLint/Vitest/Vite with patterns from the repository's own config files. A contributor who commits a malicious glob could stall a build — that is a repo-write capability, not a remote one.                                                                                                                                                                                                                                                                      |

### 3.1 The vendored Next copy — examined 2026-11-18 (previously only argued)

Inspected in an installed `next@16.4.6` (the version of PR #45) and in the built standalone output of all four apps:

| Check                                    | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| What it is                               | `next/dist/compiled/picomatch/index.js`, 23,909 bytes; its `package.json` carries no version field, so the upstream version cannot be read from it.                                                                                                                                                                                                                                                                                                                                                     |
| Does it contain the advisory's function? | **No.** The file has no `analyzeRepeatedExtglob` (nor any "repeated"-named identifier). The mechanism the advisory describes (a skipped check in that function) therefore cannot be present in this copy as described. **This does not prove the copy is unaffected**: its extglob handling was not tested, and older picomatch lines have had their own pattern-complexity issues.                                                                                                                     |
| Who calls it                             | Runtime: `shared/lib/match-remote-pattern.js` (hostname/pathname patterns) and `shared/lib/match-local-pattern.js`, both fed by `images.remotePatterns` / `images.localPatterns`. Build time: `build/segment-config/middleware/middleware-config.js` (validates a glob string from route configuration), `collect-build-traces`, `middleware-plugin`, `next-trace-entrypoints-plugin`. The pattern sources of the build-time sites were not traced beyond `next.config` and file-tracing configuration. |
| Does any app configure those inputs?     | No. `grep` over `apps/*/next.config.*` finds no `images`, `remotePatterns`, `localPatterns`, `matcher` or `allowedDevOrigins`, and no app has a `middleware`/`proxy` file.                                                                                                                                                                                                                                                                                                                              |
| What ships in the web images             | `infra/docker/web.Dockerfile` copies only `.next/standalone`. The standalone output of each of the four apps contains **exactly one** `picomatch` directory, Next's compiled copy. The lockfile's `picomatch@4.0.7` is **not** in any web bundle.                                                                                                                                                                                                                                                       |
| What ships in the API image              | `infra/docker/node-service.Dockerfile` uses `pnpm deploy --prod` (0 picomatch directories, see above).                                                                                                                                                                                                                                                                                                                                                                                                  |

## 4. Exploitability (assessment, for the reviewer to confirm)

- **Network-reachable exploitation of a shipped service: not demonstrated and not expected.** The vulnerable function is reached only with an attacker-supplied pattern; no shipped code path accepts one.
- Residual risk is **build-time denial of service** by someone who can already change repository configuration, plus the unquantified vendored Next copy.
- The CVSS vector assumes a network-reachable consumer of untrusted patterns, which does not describe this repository's use.

I have **not** run a proof-of-concept payload against the project; the reasoning above is from the dependency graph and source search, and the reviewer may wish to require one.

## 5. Options

| #   | Option                                                                   | Effect                                                                                                                                           | Cost / risk                                                                   |
| --- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| A   | **Time-bounded exception** in an `osv-scanner.toml` (below)              | CI `security` can pass again while the advisory stays visible and **expires automatically**                                                      | Scanner config change → security-reviewer approval; must be re-checked weekly |
| B   | `pnpm.overrides` to another picomatch major                              | Not possible without evidence: every published version listed by the advisory range is `<= 4.0.7` and no fixed version exists. **Not proposed.** | —                                                                             |
| C   | Remove the dependency path (replace tinyglobby/typescript-eslint/vitest) | Impractical                                                                                                                                      | Not proportionate to a dev-only path                                          |
| D   | Leave `security` red until upstream releases a fix                       | Blocks the osv step and therefore every step after it (gitleaks, Trivy) on **every** PR                                                          | Unacceptable for December                                                     |

**Recommendation: A, with an expiry, plus a weekly check for an upstream fix.**

## 6. Proposed exception (NOT applied — tested only against a temporary copy outside the repository)

`osv-scanner.toml` next to `pnpm-lock.yaml`:

```toml
[[IgnoredVulns]]
id = "GHSA-fc5q-39xc-vjpf"
ignoreUntil = 2026-12-31
reason = "picomatch ReDoS via attacker-supplied extglob PATTERNS; dev/build-tool dependency only, absent from every production image; no fixed release exists (latest 4.0.7). Re-check weekly."
```

Local verification with `ghcr.io/google/osv-scanner:v2.5.1` (the CI action's version) on this repo's lockfile:

| Case                                                             | Result                                                                             |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Lockfile as on `main` + Next 16.4.6 (PR #45), no exception       | 1 vulnerability (this one), exit 1                                                 |
| Same lockfile + the exception above                              | "Filtered 1 vulnerability", **No issues found**, exit 0                            |
| Same exception with `ignoreUntil` in the past (negative control) | the vulnerability is reported again, **exit 1** — the exception really does expire |

The exception covers exactly one advisory ID for one date range; it does not ignore other advisories or the package.

## 7. Monitoring and remediation plan (proposal — nothing is scheduled or automated yet)

| Item                                | Proposal                                                                                                                                                                                                                                                                                                                        |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Owner of the exception              | To be named by the owner (not assumed here).                                                                                                                                                                                                                                                                                    |
| Weekly check                        | Run `npm view picomatch version` and look up GHSA-fc5q-39xc-vjpf on osv.dev for a listed fixed version. Record the date and result as a one-line comment on this PR. An automated weekly job would be a CI change and needs its own approval.                                                                                   |
| Trigger to remediate early          | The moment a fixed release exists: bump it through the lockfile (a `pnpm.overrides` entry only if a normal update does not select it), run the full gate, and delete the exception in the same PR. Do not wait for the expiry date.                                                                                             |
| Expiry (owner-specified 2026-12-31) | After this date the `security` job fails again **by design**. Note that this is also the internal-alpha target date: if no fix exists by then, the owner and reviewer must make a new, evidenced renewal decision (a later `ignoreUntil` with the same single advisory ID) or choose a remediation. Renewal is never automatic. |
| If no fixed release ever appears    | Options to evaluate then, not now: replacing `tinyglobby`/the typescript-eslint glob path, or an upstream fix. None is assessed in this document.                                                                                                                                                                               |
| Scope guard                         | The exception names one advisory ID. Any other advisory, or this advisory reported in a different package, still fails the job.                                                                                                                                                                                                 |
| Other controls that stay on         | `deploy --prod` keeps the API image free of the package; Trivy image scanning (a step after osv-scanner in CI, currently skipped by the failure) would flag the package if it ever appeared in an image.                                                                                                                        |

## 8. Review checklist for the independent security reviewer

| #   | Review item (owner-listed 2026-11-18)  | Evidence in this document                                                                                                                                     | Reviewer to confirm                                                                              |
| --- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| 1   | Exact vulnerable dependency path       | §2 (`pnpm why picomatch -r`: single version 4.0.7, via `tinyglobby` ← `typescript-eslint` / `vite` ← `vitest`)                                                | Re-run `pnpm why picomatch -r` on the merge candidate                                            |
| 2   | Production versus development exposure | §3, §3.1: 0 copies in the API deploy output; each web standalone bundle holds only Next's vendored copy                                                       | Re-run the `deploy --prod` listing and the standalone scan on the images that will actually ship |
| 3   | Any unexamined runtime exposure        | §3.1 examined the vendored copy; **still unexamined**: its extglob behaviour under a crafted pattern, and the pattern sources of Next's build-time call sites | Decide whether a sandboxed proof-of-concept is required (none was run)                           |
| 4   | Exception scope and expiry             | §6: one ID, `ignoreUntil = 2026-12-31`, negative control shows it expires                                                                                     | Approve the scope and the date, or set another                                                   |
| 5   | Monitoring and remediation plan        | §7                                                                                                                                                            | Approve, name the exception owner                                                                |

## 9. Decisions needed

1. Owner + independent security reviewer: accept option A with `ignoreUntil = 2026-12-31` (as the owner specified; see the alpha-date note in §7), or choose another date.
2. If accepted, a **separate** PR adds only `osv-scanner.toml`. Until then, the CI `security` job stays red at the osv-scanner step, and the gitleaks step behind it does not execute in CI.
3. Decide whether to require a sandboxed proof-of-concept before accepting the residual risk (checklist item 3).
4. Name the exception owner for the weekly check.
