# CI scanner independence and the results gate

Status: **review-only change**. Nothing here is approved by an independent security reviewer.

## What changed, and what did not

In the `security` job of `.github/workflows/ci.yml`:

- OSV, both Gitleaks steps and both Trivy scans each have a step `id` and `if: ${{ !cancelled() }}`. One scanner failing no longer leaves another one skipped. A failed step still makes the job red.
- A **scanner gate** runs last (`tooling/scripts/scanner-gate.mjs`). It reads every scanner step's outcome and fails unless each is exactly `success`, and it fails when the input a scanner reads is empty.
- A **self-test** (`tooling/scripts/scanner-gate.test.mjs`, 104 checks) runs before the gate and is itself one of the results the gate requires.

**Unchanged:** every scanner version (`osv-scanner-action@v2.5.1`, `trivy-action@v0.36.0`, gitleaks 8.24.3 by digest), every argument, both severity thresholds (`HIGH,CRITICAL`), the Trivy config scan's blocking `exit-code: '1'`, and `.gitleaks.toml`. **Trivy's filesystem scan stays report-only** (`exit-code: '0'`, "tighten during hardening (Phase 10)"). The gate does not make its findings blocking: it requires only that the scan ran, succeeded and had something to scan. The self-test pins all of this, so changing the policy later is a deliberate edit to a test, not a silent drift. The job name is unchanged, so required-check names are unchanged.

## Why: what was observed

1. **Trivy was skipped whenever OSV failed.** The Trivy steps had no `if:`, so they used the default `success()`. On PR #62's run (`46063615955`) OSV failed on `main`'s lockfile and both Trivy steps were skipped: no Trivy result existed for that PR.
2. **The pinned OSV action turns "scanned nothing" into success.** `ghcr.io/google/osv-scanner-action:v2.5.1` runs `/root/exit_code_redirect.sh`, which sets the exit code to 0 when osv-scanner exits 128 (`No package sources found`) and prints only a warning. Reproduced against the pinned image: a missing and a 0-byte `pnpm-lock.yaml` both print `Exit code: 128` and the container exits 0. The documented opt-out cannot be used from this workflow: `--allow-no-lockfiles=false` in `scan-args` makes osv-scanner itself exit 127 (the wrapper reads flags from every argument except the last, and `scan-args` is the last). A real lockfile still fails correctly: the control scan of `main`'s lockfile found 765 packages, 8 known vulnerabilities, exit 1.
3. **Trivy exits 0 on an empty directory.** Trivy 0.75.0, run locally: `fs` and `config` over an empty directory print `Supported files for scanner(s) not found` and exit 0. A missing target is a fatal error with exit 1 even under `--exit-code 0`, so report-only cannot swallow a crash. CI runs Trivy 0.70.0; the empty-directory behaviour was not re-run on that version.

Points 2 and 3 are the same defect class as the Gitleaks gap: an empty scan is not a successful scan. Independence makes it matter more, because OSV and Trivy now run even when the install step failed.

## The gate

`scanner-gate.mjs` exits 0 only if all of these hold, and reports every problem, not only the first:

- each of six step outcomes is exactly `success` (`osv`, `gitleaks_selftest`, `gitleaks_scan`, `trivy_config`, `trivy_fs`, `scanner_selftest`). `failure`, `skipped`, `cancelled`, empty, absent (step removed or id renamed), a different case, or stray whitespace all fail with a distinct reason;
- `pnpm-lock.yaml` exists, is non-empty, starts with `lockfileVersion:` and has at least one package entry (the input OSV and Trivy read);
- `infra/docker` holds at least one non-empty Dockerfile (the input of the Trivy config scan).

It writes a per-scanner table to the job summary.

## How it is tested

- **Gate:** every scanner × eleven bad outcomes, several failures at once, seven vacuous-input cases, and the step summary.
- **Workflow:** the real `if:` lines are parsed and run through a model of GitHub's step-status rules. It asserts that Trivy and the gate run when OSV fails, that any single failing step (setup, install, SBOM or any scanner) leaves every other scanner and the gate running, that the job is then red, that a cancelled run is never success, that no step carries `continue-on-error`, that no scanner step exists that the gate does not read, and that the gate is last and wired to every `steps.<id>.outcome`.
- **Real GitHub:** the pull request of this change is based on a lockfile where OSV fails, so its own run shows the Trivy steps executing after a failed OSV.
- **Mutation sweep:** 33 mutants of the gate and the workflow (accept `skipped`, accept an empty result, drop an input check, remove an `if:`, add `continue-on-error`, make Trivy filesystem blocking, move a version, weaken a severity, mis-wire a result, add an unread scanner, and others). All are caught; one survived the first pass and exposed a vacuous assertion, which was tightened.

## Limits

- The gate proves the scan inputs exist and are non-trivial and that each scanner step ended in `success`. It does not read scanner logs, so it cannot prove a scanner read those inputs.
- The model of GitHub's status rules is tested against one real scenario (OSV failing). Other combinations rely on GitHub's documented semantics.
- The all-green path of the gate on GitHub is first observed when this change runs on a branch where OSV passes. It is covered by the self-test and by the gate run against this repository's real inputs.
- The `security` job keeps its 20-minute timeout. A timeout cancels the job, which is never success.
