# Gitleaks CI coverage: root cause and the explicit-range gate

Status: **review-only change**. Nothing here is approved by an independent security reviewer.

## What was wrong

The `security` job used `gitleaks/gitleaks-action@v2.3.9`. On the runs inspected, that step printed `✅ No leaks detected` while **scanning zero commits**. A step that scans nothing and exits 0 looks identical to a clean scan.

### Evidence

| Where                                                       | Real result of the old step                                                                                                      |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Push runs to `main`, the last 14 (`gh run list`, step logs) | **0 commits scanned on 11 runs**, 1 commit on one run, and the step was **skipped** on 3 runs because `osv-scanner` failed first |
| PR #55 run `44461667757`                                    | 0 commits scanned (36 commits, 23 with a diff)                                                                                   |
| PR #60 job `140661543210`                                   | 0 commits scanned (54 commits, 38 with a diff)                                                                                   |
| Real merge to `main`, PR #39, run `42779447740`             | range `bfed5f9^..b2e3fb1`, `--no-merges --first-parent`: 0 commits scanned                                                       |

### Root cause (confirmed in the action source at v2.3.9 and in the logs)

1. **Range taken from an un-paginated list.** For pull requests the action calls `GET /pulls/{n}/commits` with no `per_page` and no paging, so it sees at most 30 commits. PR #55 (36 commits) and PR #60 (54 commits) returned 30.
2. **First and last entry used as base and head.** `baseRef = commits[0]`, `headRef = commits[last]`. On a merge-heavy branch the first commit is not an ancestor of the last one on the first-parent chain.
3. **`--no-merges --first-parent <base>^..<head>`.** On such a branch that walk holds only merge commits, which `--no-merges` removes, so the result is empty. `--first-parent` also drops every commit reachable only through a merged side branch, **on small pull requests too** (PR #54 has 11 commits, 6 with a diff, and the old range for it holds 0).
4. **Push events use the same shape**: `commits[0]` and `commits[last]` from the webhook payload, the same flags. Every merge commit on `main` hit the same hole.
5. **An empty range is a pass.** Gitleaks 8.24.3 prints `0 commits scanned` and `no leaks found` and exits 0 on an empty range. An unresolvable range exits 1.
6. **Nothing checked the count**, and every step after `osv-scanner` was skipped whenever it failed (the gitleaks step was skipped on 3 of the last 14 `main` runs; on the latest one `osv-scanner` is the failing step).

Checked and **not** a cause: checkout depth (`fetch-depth: 0`, repository not shallow, full history present).

Per-PR comparison, computed with git from each pull request's real SHAs, of what the old range holds against what the pull request holds (non-merge commits with a diff). Only #55, #57 and #60 have a real old-step log (see above); the rest is arithmetic on the same algorithm.

| PR  | Commits | Old step would scan | Actually in the PR |
| --- | ------- | ------------------- | ------------------ |
| #54 | 11      | 0                   | 6                  |
| #55 | 36      | 0                   | 23                 |
| #56 | 6       | 6                   | 6                  |
| #57 | 3       | 3                   | 3                  |
| #58 | 10      | 10                  | 10                 |
| #59 | 5       | 3                   | 3                  |
| #60 | 54      | 0                   | 38                 |

## The fix

`tooling/scripts/gitleaks-scan.sh` replaces the action. It runs the **same gitleaks 8.24.3** (pinned by image digest) with the **same `.gitleaks.toml`**, in `git` mode, over an explicit range, and fails closed.

- **Range**: `pull_request` uses the payload's `base.sha..head.sha`; `push` uses `before..after`. No `--first-parent`, no `--no-merges`, no first/last guessing, no paging. All values arrive as environment variables.
- **Fails (exit 1) when**: the event is not `pull_request` or `push`; a SHA is not a full 40-character lowercase hex or is all zeros; the clone is shallow; base or head is not in the clone; the range is empty; the payload's `pull_request.commits` differs from `git rev-list --count`; no commit in the range carries a diff; the config file is missing, empty, or holds only blank lines and comments; **the scanner, given that config, does not detect a planted fake GitHub token and fake private key** (see "Empty and rule-less configurations" below); the scanner errors; the scanner prints no commit count; the scanner scanned 0; the scanner's count is not **exactly** the number of commits in the range that carry a diff.
- **Exit 2** when gitleaks finds a leak (the values are redacted in the log).
- **Self-test** (`tooling/scripts/gitleaks-scan.test.sh`) runs in the same job before the real scan. It builds disposable repositories and plants fake secrets generated at run time.
- Both steps run with `if: ${{ !cancelled() }}`, so a failing `osv-scanner` no longer leaves the secret scan skipped. The job still fails when any step fails.

`.gitleaks.toml`, the OSV step and both Trivy steps are unchanged. No allowlist was added or widened.

## Empty and rule-less configurations (second review finding, 2026-11-28)

**Defect.** Gitleaks 8.24.3 accepts a config that defines **no effective rules** and then reports `no leaks found` with exit 0 after scanning every commit. The scanner does not distinguish "scanned and clean" from "had nothing to look for". Checked on the pinned image, each of these exits **0** on a directory holding a fake GitHub token and a fake private key:

- an empty file, a whitespace-only file, a comments-only file, a `title = "..."`-only file
- an `[allowlist]` without `[extend]` (no rules at all)
- `[extend] useDefault = true` together with an allowlist whose path or regex matches every file
- `[extend] useDefault = true` together with `disabledRules` naming the rules that would fire
- a custom rule that can never match

Invalid TOML exits 1 and `[extend] useDefault = true` (the committed config) detects both secrets. The range scan above did count commits, so the "scanner scanned 0" and "count differs" checks did **not** catch this: the commits were scanned, against zero rules. Because the config comes from the pull request's own checkout, a one-line change to `.gitleaks.toml` could turn the gate into a no-op that reports success.

**Fix (fail closed, before the range scan).**

1. A config that is empty, or holds only blank lines and comments, is refused without running the scanner.
2. **Canary proof.** The script builds a disposable directory holding a fake GitHub token (`ghp_` plus 36 random characters) and a fake PEM private key, assembled at run time from split fragments so that no secret-shaped literal exists in the repository. The **same pinned scanner with the same config** must exit 2 on that directory and print **both** the `github-pat` and the `private-key` rule ids. Exit 0 (nothing detected), any other exit code (the scanner could not use the config) or a missing rule id stops the job **before** the range is scanned.
3. The success path asserts that the canary was proved, so a later edit cannot reach `OK` without it.

The canary file name is deliberately outside every documented fixture allowlist, so the proof is not helped by an exemption. Nothing was added to `.gitleaks.toml`, and no exemption, threshold or existing check was loosened. The documented fixture allowlists in `main`'s config and in PR #47's config still pass the canary and still scan their fixtures (the suite was run with both configs).

## Evidence (local, 2026-11-28; the GitHub run is recorded on the pull request)

- **The first GitHub run of this change (PR #61) was red for the right reason.** The real scan covered its 1 commit and reported `leaks found: 2`: the self-test stored the documented fake test password as a literal in a file that is not on the allowlisted path. It is now assembled at run time, and **no exemption was added**. Because the gate scans history, that pushed commit keeps failing, and published history is not rewritten, so this branch is a clean replacement. The same run showed that the log named no file or rule, so the scan now runs with `-v` (values stay redacted) and the suite checks both.
- **Self-test: 77 checks with `main`'s config and 79 with PR #47's config, 0 failed, exit 0**, against the pinned image (52 checks before the configuration guard; the guard adds section 10, 25 checks; the 1 N/A with `main`'s config is the approval-patch fixture check that needs #47's config). It covers a 3-commit and a 1-commit PR, a 45-commit linear PR, a 51-commit merge-heavy PR (39 commits with a diff), planted fake secrets (one at commit 45 of 45, one only on the last merged side branch), the documented fixture allowlists and their non-widening, ten invalid-SHA and payload cases, empty, swapped, truncated, shallow and non-repository cases, push events, and a stub scanner that lies in five ways.
- **The old logic fails the same fixtures.** On the merge-heavy fixture it scans 2 of 39 commits and exits 0; it exits 0 on both planted secrets it cannot reach (the side-branch secret, also on a 3-commit PR).
- **Mutation sweep of the gate script: 18 mutants, all caught.** 12 of the first 16 were caught on the first pass. The other 4 survived: one removed a guard that another also covers, and three exposed weak checks in the suite (an unknown event, a missing config, an exit code judged only together with the count). The suite now asserts the exact failure reason in each, and those 4 are caught. Two more (no `-v`; no `--redact`, which would print the secret in the CI log) are caught by the log checks. The 12 first-pass catches were not re-run against the final suite, which only adds assertions.
- **Configuration guard, tested against the real pinned scanner (section 10 of the self-test, 25 checks).** Twelve configurations were first run through the pinned image: empty, comments-only, whitespace-only, title-only, allowlist-only (no `[extend]`), extend-only, `[extend]` plus a match-everything allowlist, `[extend]` plus `disabledRules`, a never-firing custom rule, invalid TOML, `main`'s config and #47's config. Eight of them exit 0 on a directory holding the fake secrets; invalid TOML exits 1; both real configs detect both canary rules. The script now rejects each of the eight, rejects invalid TOML with the scanner's reason, accepts both real configs (including the documented fixture allowlists), and the self-test asserts the exact reason in each case. A stub scanner that exits 0, prints no rule, prints only one of the two rules, or prints rule names inside other text is refused; a stub that detects both is accepted and then scans the range.
- **Mutation sweep of the config guard: 12 mutants, 11 caught.** Caught: the empty check removed, the comments-only check removed, canary exit 0 accepted, scanner error accepted, the rule loop emptied, only one rule required, any rule id accepted, the canary run ignoring the config, a faked canary output, the canary file on an allowlisted path, and the canary scan told to exit 0. **One survivor, analysed, not hidden:** deleting the final `CANARY_PROVED` assertion changes nothing today, because every path that leaves the canary block without proof has already exited. It is a defence-in-depth line against a later edit, so no test can reach it. An identical-text control survived as it must, which also confirms that the suite passes on the final script text.
- **Real pull-request ranges, each with the `.gitleaks.toml` of its own head, exit 0 with the scanned count equal to the commits with a diff:** #54 6, #55 23, #56 6, #57 3, #58 10, #59 3, #60 38 (also as a `push` event). Old step: 0 for #54, #55 and #60.
- **Full history of `main`** (131 commits with a diff, `main`'s config): `131 commits scanned`, no leaks. Merges to `main` were not covered by the old step, so this is the compensating evidence.

## Limits that remain

- `git log -p` shows no patch for a merge commit: a secret that appears **only** in a merge-conflict resolution is not seen. Merge-only or empty-only ranges fail closed instead of passing.
- The config (and any ignore file) comes from the checkout, so a pull request can change its own `.gitleaks.toml`. A reviewer must read any change to that file.
- **The canary proves the config can detect two secret kinds at all; it does not judge a targeted allowlist.** A config that keeps the default rules but allowlists one specific real file, path or regex still passes the canary and hides that one thing. That is the case for the reviewer reading any `.gitleaks.toml` diff. It is also not a proof about every other rule: a config that disables only some other rule passes.
- The inline `gitleaks:allow` comment suppression was not tested.
- Only the commits of the pull request or push are scanned, not older history. A full-history scan is a separate, manual step.
- A push whose `before` is unreachable (a force-push) or all zeros (a new branch) fails closed. The workflow triggers pushes to `main` only.
- The action posted inline review comments on a leak. The gate writes the redacted finding to the job log only.
- `osv-scanner` still fails on `main` (the `effect` advisory is fixed only in PR #57), and the two Trivy steps still run only after it succeeds. That ordering is outside this change.
- The pinned image digest must be bumped deliberately (the script header names the version).

## Run it locally

```sh
bash tooling/scripts/gitleaks-scan.test.sh        # needs docker; about two minutes
EVENT_NAME=pull_request PR_BASE_SHA=<sha> PR_HEAD_SHA=<sha> PR_COMMITS=<n> \
  bash tooling/scripts/gitleaks-scan.sh
```
