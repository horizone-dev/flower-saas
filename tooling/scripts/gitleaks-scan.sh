#!/usr/bin/env bash
# gitleaks-scan.sh: the CI secret-scan gate. Scans an EXPLICIT commit range taken from the event payload and fails closed if it cannot prove
# that the whole range was scanned.
#
# Why it replaces gitleaks/gitleaks-action 2.3.9 (see docs/security/GITLEAKS-CI-COVERAGE.md):
#   - on pull requests the action lists the PR's commits through the API without pagination (30 per page), takes the first and the last entry of that
#     list as base and head, and runs `--no-merges --first-parent <first>^..<last>`;
#   - on merge-heavy branches that range holds no commits on the first-parent chain, so gitleaks scans ZERO commits and still exits 0;
#   - `--first-parent` also skips every commit that is reachable only through a merged side branch, on small pull requests too.
# Here the range is `base..head` from the payload, with no --first-parent, and the job FAILS unless the scanner's own count of scanned commits equals
# the number git says the range holds.
#
# Inputs (environment, never interpolated into the command line):
#   EVENT_NAME      pull_request | push
#   PR_BASE_SHA, PR_HEAD_SHA, PR_COMMITS    pull_request: payload base.sha, head.sha and the payload's own commit count
#   PUSH_BEFORE, PUSH_AFTER                 push: payload before and after
#   GITLEAKS_CONFIG optional, default <repo>/.gitleaks.toml; must exist, the default rule set is never used silently
#   GITLEAKS_BIN    optional scanner executable (tests only); default is the digest-pinned image below
# Exit codes: 0 whole range scanned and clean, 1 anything that stops us proving that, 2 leaks found.
# Needs: bash, git, and docker (unless GITLEAKS_BIN is set). Run from inside the clone being scanned (CI: fetch-depth 0).

set -uo pipefail
export MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*'

# gitleaks v8.24.3, the version gitleaks-action 2.3.9 bundled. The multi-arch index digest, so the tag cannot be re-pointed. Change it deliberately.
IMAGE='ghcr.io/gitleaks/gitleaks@sha256:e1b35e12a8c6fa8901f060459cfb6b2fc4c484d3afbe3b029733a3bbfab07055'

say() { printf 'gitleaks-scan: %s\n' "$*"; }
fail() {
  printf 'gitleaks-scan: FAIL: %s\n' "$*" >&2
  exit 1
}

SHA_RE='^[0-9a-f]{40}$'
ZERO_SHA='0000000000000000000000000000000000000000'
is_sha() { [[ "$1" =~ $SHA_RE ]] && [ "$1" != "$ZERO_SHA" ]; }

# ---- 1. the intended range, from the event payload -------------------------------------------------------------------------------------------
DECLARED=''
case "${EVENT_NAME:-}" in
  pull_request)
    BASE="${PR_BASE_SHA:-}"
    HEAD="${PR_HEAD_SHA:-}"
    DECLARED="${PR_COMMITS:-}"
    [[ "$DECLARED" =~ ^[0-9]+$ ]] || fail "the pull request commit count from the event payload is missing or not a number ('${DECLARED}')"
    ;;
  push)
    BASE="${PUSH_BEFORE:-}"
    HEAD="${PUSH_AFTER:-}"
    ;;
  *) fail "unsupported event '${EVENT_NAME:-}': this gate scans pull_request and push events only, and refuses to scan nothing" ;;
esac
is_sha "$BASE" || fail "base is not a full 40-character commit SHA (or is the all-zero SHA, e.g. a brand-new branch): '${BASE}'"
is_sha "$HEAD" || fail "head is not a full 40-character commit SHA: '${HEAD}'"

# ---- 2. the clone must hold the whole range --------------------------------------------------------------------------------------------------
git rev-parse --git-dir > /dev/null 2>&1 || fail "not inside a git repository"
TOP="$(git rev-parse --show-toplevel)" || fail "cannot resolve the repository top level"
COMMON_GIT="$(git rev-parse --path-format=absolute --git-common-dir)" || fail "cannot resolve the git directory"
[ "$(git rev-parse --is-shallow-repository)" = false ] || fail "the clone is shallow, so the history is truncated; check out with fetch-depth: 0"
git cat-file -e "${BASE}^{commit}" 2> /dev/null || fail "base ${BASE} is not a commit in this clone"
git cat-file -e "${HEAD}^{commit}" 2> /dev/null || fail "head ${HEAD} is not a commit in this clone"
RANGE="${BASE}..${HEAD}"

# ---- 3. what the range must contain ----------------------------------------------------------------------------------------------------------
TOTAL="$(git rev-list --count "$RANGE")" || fail "git could not walk ${RANGE}"
NONMERGE="$(git rev-list --no-merges --count "$RANGE")" || fail "git could not walk ${RANGE}"
[ "$TOTAL" -ge 1 ] || fail "the range ${RANGE} is empty (0 commits): nothing would be scanned"
if [ -n "$DECLARED" ] && [ "$TOTAL" != "$DECLARED" ]; then
  fail "the event payload says the pull request has ${DECLARED} commits but git resolves ${TOTAL} in ${RANGE}: the history is truncated or the SHAs are inconsistent"
fi
# gitleaks reads `git log -p`: a merge commit has no patch and an empty commit has no diff, so neither is counted. Count exactly what it can count.
SCANNABLE="$(git log --no-merges --no-renames --raw --format='commit %H' "$RANGE" | awk '/^commit /{n++} /^:/{if(!s[n]){s[n]=1;d++}} END{print d+0}')"
[[ "$SCANNABLE" =~ ^[0-9]+$ ]] || fail "could not count the scannable commits in ${RANGE}"
[ "$SCANNABLE" -ge 1 ] || fail "none of the ${TOTAL} commits in ${RANGE} carries a diff the scanner can read (merge or empty commits only)"
say "range ${RANGE}: ${TOTAL} commits, ${NONMERGE} non-merge, ${SCANNABLE} carry a diff and must all be scanned (event: ${EVENT_NAME})"

# ---- 4. the scanner and its configuration ----------------------------------------------------------------------------------------------------
CONFIG="${GITLEAKS_CONFIG:-$TOP/.gitleaks.toml}"
[ -f "$CONFIG" ] || fail "gitleaks config not found: '${CONFIG}' (refusing to fall back to the default rules)"
CONFIG="$(cd "$(dirname "$CONFIG")" && pwd)/$(basename "$CONFIG")"
hostpath() { if command -v cygpath > /dev/null 2>&1; then cygpath -m "$1"; else printf '%s' "$1"; fi; }

OUTFILE="$(mktemp)" || fail "cannot create a temporary file"
trap 'rm -f -- "$OUTFILE"' EXIT

if [ -n "${GITLEAKS_BIN:-}" ]; then
  [ -x "$GITLEAKS_BIN" ] || fail "GITLEAKS_BIN is not an executable file: '${GITLEAKS_BIN}'"
  "$GITLEAKS_BIN" git "$TOP" --config "$CONFIG" --log-opts="$RANGE" --no-banner --redact -v --exit-code 2 2>&1 | tee "$OUTFILE"
  RC="${PIPESTATUS[0]}"
else
  command -v docker > /dev/null 2>&1 || fail "docker is required to run the pinned gitleaks image"
  docker run --rm \
    -v "$(hostpath "$COMMON_GIT"):/g:ro" \
    -v "$(hostpath "$CONFIG"):/cfg/gitleaks.toml:ro" \
    -e GIT_CONFIG_COUNT=1 -e GIT_CONFIG_KEY_0=safe.directory -e GIT_CONFIG_VALUE_0='*' \
    "$IMAGE" git /g --config /cfg/gitleaks.toml --log-opts="$RANGE" --no-banner --redact -v --exit-code 2 2>&1 | tee "$OUTFILE"
  RC="${PIPESTATUS[0]}"
fi

# ---- 5. judge the result ---------------------------------------------------------------------------------------------------------------------
REPORTED="$(sed 's/\x1b\[[0-9;]*[A-Za-z]//g' "$OUTFILE" | grep -Eo '[0-9]+ commits? scanned' | tail -1 | grep -Eo '^[0-9]+')"
if [ -n "$REPORTED" ]; then say "gitleaks reported ${REPORTED} commits scanned (exit code ${RC})"; fi

if [ "$RC" -eq 2 ]; then
  say "LEAKS FOUND in ${RANGE}: the job fails. The values are redacted above; rotate any real credential and remove it from the branch history."
  exit 2
fi
[ "$RC" -eq 0 ] || fail "the scanner exited with code ${RC} (an error, not a verdict)"
[ -n "$REPORTED" ] || fail "the scanner exited 0 but printed no commit count, so the scanned range cannot be verified"
[ "$REPORTED" -ge 1 ] || fail "the scanner exited 0 but scanned 0 commits: an empty scan is not a pass"
[ "$REPORTED" = "$SCANNABLE" ] || fail "the scanner covered ${REPORTED} commits but ${SCANNABLE} are in ${RANGE}: a partial scan is not a pass"
say "OK: scanned ${REPORTED} of ${SCANNABLE} scannable commits in ${RANGE} (${TOTAL} total, ${NONMERGE} non-merge); no leaks found"
exit 0
