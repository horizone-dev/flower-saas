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
#   GITLEAKS_CONFIG optional, default <repo>/.gitleaks.toml; must exist, must not be empty, and must be PROVEN to detect (see below); the default
#                   rule set is never used silently
#   GITLEAKS_BIN    optional scanner executable (tests only); default is the digest-pinned image below
#
# A scan with no effective rules is not a scan. gitleaks v8.24.3 accepts a config that defines no rules (empty, comments only, title only,
# allowlist without `[extend] useDefault = true`) and a config whose allowlist covers everything or whose `disabledRules` removes the rules, scans the
# whole range and prints "no leaks found" with exit 0. So before the range is scanned, the SAME scanner with the SAME config must detect a canary: a
# disposable file holding a fake GitHub token and a fake private key, assembled at run time from fragments (no secret-shaped literal lives here, and
# no config can be tuned to a fixed string). Exit code 2 and both rule ids (github-pat, private-key) are required; anything else fails the job.
# This proves the config is not blind. It does not judge a config that detects the canary but exempts something else on purpose: allowlist entries
# stay a matter for the security review of any change to .gitleaks.toml.
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
[ -s "$CONFIG" ] || fail "gitleaks config is empty: '${CONFIG}' (a scan with no rules reports a clean result and exits 0, so an empty config is refused)"
grep -Eq '^[[:space:]]*[^[:space:]#]' "$CONFIG" || fail "gitleaks config holds only blank lines and comments: '${CONFIG}' (it defines no rules, so it is refused)"
if [ -n "${GITLEAKS_BIN:-}" ]; then [ -x "$GITLEAKS_BIN" ] || fail "GITLEAKS_BIN is not an executable file: '${GITLEAKS_BIN}'"; fi
if [ -z "${GITLEAKS_BIN:-}" ]; then command -v docker > /dev/null 2>&1 || fail "docker is required to run the pinned gitleaks image"; fi

OUTFILE=''
CANARY_DIR=''
CANARY_OUT=''
cleanup() {
  [ -n "$OUTFILE" ] && rm -f -- "$OUTFILE"
  [ -n "$CANARY_OUT" ] && rm -f -- "$CANARY_OUT"
  [ -n "$CANARY_DIR" ] && [ -d "$CANARY_DIR" ] && rm -rf -- "$CANARY_DIR"
  return 0
}
trap cleanup EXIT
OUTFILE="$(mktemp)" || fail "cannot create a temporary file"
CANARY_OUT="$(mktemp)" || fail "cannot create a temporary file"
CANARY_DIR="$(mktemp -d)" || fail "cannot create a temporary directory"

# ---- 4a. prove that this config has effective detection rules, with the scanner and config used for the real scan -----------------------------
rand_alnum() { # rand_alnum N: N random [A-Za-z0-9] characters, at least 12 distinct so the entropy gate of a rule cannot make the check flaky
  local s tries=0
  while [ "$tries" -lt 20 ]; do
    s="$(LC_ALL=C tr -dc 'A-Za-z0-9' < /dev/urandom | head -c "$1")" # head closes the pipe and ends tr with SIGPIPE; only the captured length is judged
    if [ "${#s}" -eq "$1" ] && [ "$(printf '%s' "$s" | fold -w1 | sort -u | wc -l)" -ge 12 ]; then
      printf '%s' "$s"
      return 0
    fi
    tries=$((tries + 1))
  done
  return 1
}
PAT_TAIL="$(rand_alnum 36)" || fail "cannot generate the canary (no usable random source)"
KEY_ROW1="$(rand_alnum 64)" || fail "cannot generate the canary (no usable random source)"
KEY_ROW2="$(rand_alnum 64)" || fail "cannot generate the canary (no usable random source)"
{
  printf '%s%s%s\n' 'gh' 'p_' "$PAT_TAIL"
  printf '%s%s\n' '-----BEGIN RSA PRIV' 'ATE KEY-----'
  printf '%s\n%s\n' "$KEY_ROW1" "$KEY_ROW2"
  printf '%s%s\n' '-----END RSA PRIV' 'ATE KEY-----'
} > "$CANARY_DIR/canary.txt" || fail "cannot write the canary file"

if [ -n "${GITLEAKS_BIN:-}" ]; then
  "$GITLEAKS_BIN" dir "$(hostpath "$CANARY_DIR")" --config "$CONFIG" --no-banner --redact -v --exit-code 2 > "$CANARY_OUT" 2>&1
  CRC=$?
else
  docker run --rm \
    -v "$(hostpath "$CANARY_DIR"):/canary:ro" \
    -v "$(hostpath "$CONFIG"):/cfg/gitleaks.toml:ro" \
    "$IMAGE" dir /canary --config /cfg/gitleaks.toml --no-banner --redact -v --exit-code 2 > "$CANARY_OUT" 2>&1
  CRC=$?
fi
sed -i 's/\x1b\[[0-9;]*[A-Za-z]//g' "$CANARY_OUT"
case "$CRC" in
  2) ;;
  0) fail "this config detects nothing in a file that holds a fake GitHub token and a fake private key: it defines no effective detection rules (rule-less, allowlisting everything, or its rules disabled). An empty scan is not a pass, so the range was not scanned" ;;
  *) fail "the scanner could not use this config (exit code ${CRC}): $(grep -E 'FTL|ERR' "$CANARY_OUT" | tail -2 | tr '\n' ' ')" ;;
esac
for CANARY_RULE in github-pat private-key; do
  grep -Eq "^RuleID:[[:space:]]+${CANARY_RULE}[[:space:]]*\$" "$CANARY_OUT" ||
    fail "this config does not detect the canary for rule '${CANARY_RULE}' (rules that fired: $(grep -E '^RuleID:' "$CANARY_OUT" | awk '{print $2}' | sort -u | tr '\n' ' ')): a default rule is disabled or neutralised, so the range was not scanned"
done
CANARY_PROVED=1
say "config check: '${CONFIG##*/}' detects the canary secrets (github-pat, private-key): the rule set is effective"

if [ -n "${GITLEAKS_BIN:-}" ]; then
  "$GITLEAKS_BIN" git "$TOP" --config "$CONFIG" --log-opts="$RANGE" --no-banner --redact -v --exit-code 2 2>&1 | tee "$OUTFILE"
  RC="${PIPESTATUS[0]}"
else
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
# defence in depth: a later edit that moves or drops the config proof must not be able to turn a rule-less scan into a pass
[ "${CANARY_PROVED:-0}" = 1 ] || fail "internal error: reached the success path without proving that the config has effective detection rules"
say "OK: scanned ${REPORTED} of ${SCANNABLE} scannable commits in ${RANGE} (${TOTAL} total, ${NONMERGE} non-merge); no leaks found"
exit 0
