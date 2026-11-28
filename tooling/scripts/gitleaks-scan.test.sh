#!/usr/bin/env bash
# Tests for tooling/scripts/gitleaks-scan.sh, the CI secret-scan gate.
#
# Why this exists: gitleaks-action 2.3.9 derived its commit range from an un-paginated API listing (first 30 commits), took the first and the last
# of that chronological list as base and head, and ran `--no-merges --first-parent`. On merge-heavy integration PRs that scanned ZERO commits and
# still printed "No leaks detected". These tests pin the replacement: the intended range comes from the event payload, the whole range is scanned,
# and every way of scanning less than that FAILS the job.
#
# Every repository below is disposable (mktemp). The "secret" is generated at run time from parts, is shaped like an AWS access key and belongs
# to nothing, so no secret-shaped literal is stored in this file or in the repository.
# Needs: bash, git, docker (the pinned gitleaks image). Config under test: $GITLEAKS_CONFIG or the repository's .gitleaks.toml.

set -u
export MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*'

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUT="${GITLEAKS_SCAN_SUT:-$HERE/gitleaks-scan.sh}" # an override exists only so the mutation sweep can point the suite at a mutated copy
ROOT="$(cd "$HERE/../.." && pwd)"
if command -v cygpath > /dev/null 2>&1; then ROOT="$(cygpath -m "$ROOT")"; fi # git.exe must understand it too
CONFIG="${GITLEAKS_CONFIG:-$ROOT/.gitleaks.toml}"
IMG="$(grep -Eo 'ghcr\.io/gitleaks/gitleaks@sha256:[0-9a-f]{64}' "$SUT" 2> /dev/null | head -1)"
WORK="$(mktemp -d)"
# git.exe and the msys tools must agree on every path: use the Windows-mixed form (C:/...) where cygpath exists, the plain path elsewhere
if command -v cygpath > /dev/null 2>&1; then WORK="$(cygpath -m "$WORK")"; fi
OUT="$WORK/sut.out"
cleanup() { [ -n "${WORK:-}" ] && [ -d "$WORK" ] && rm -rf -- "$WORK"; }
trap cleanup EXIT

PASS=0
FAIL=0
RC=""
SCANNED=""
info() { echo "exit=${RC:-?} scanned=${SCANNED:-n/a}"; }
ok() { echo "  PASS  $1  [$(info)]"; PASS=$((PASS + 1)); }
bad() { echo "  FAIL  $1  [$(info)]"; FAIL=$((FAIL + 1)); }
# chk NAME 'condition': the condition runs in a subshell, so a failing command inside it fails that check only
chk() { if (eval "$2"); then ok "$1"; else bad "$1"; fi; }
has() { grep -qF -- "$1" "$OUT"; }

hp() { if command -v cygpath > /dev/null 2>&1; then cygpath -m "$1"; else printf '%s' "$1"; fi; }

# ---- disposable repositories with deterministic, strictly increasing commit times ------------------------------------------------------------
TS=1700000000
tick() { TS=$((TS + 60)); }
mk() {
  local d="$WORK/$1"
  mkdir -p "$d"
  git -C "$d" init -q -b main
  # never let a `git config` below land in some enclosing repository: the new repo must be its own top level
  [ "$(git -C "$d" rev-parse --show-toplevel 2> /dev/null)" = "$d" ] || {
    echo "ABORT: $d is not its own git repository (path mismatch between bash and git)" >&2
    exit 2
  }
  git -C "$d" config user.name "Test"
  git -C "$d" config user.email "test@example.invalid"
  git -C "$d" config commit.gpgsign false
  git -C "$d" config core.autocrlf false
  printf '%s' "$d"
}
cm() { # cm REPO FILE CONTENT MESSAGE
  local r="$1" f="$2"
  mkdir -p "$r/$(dirname "$f")"
  printf '%s\n' "$3" > "$r/$f"
  git -C "$r" add -- "$f"
  tick
  GIT_AUTHOR_DATE="@$TS +0000" GIT_COMMITTER_DATE="@$TS +0000" git -C "$r" commit -q -m "$4"
}
mg() { # mg REPO BRANCH MESSAGE: merge with a merge commit
  tick
  GIT_AUTHOR_DATE="@$TS +0000" GIT_COMMITTER_DATE="@$TS +0000" git -C "$1" merge -q --no-ff -m "$3" "$2"
}
head_of() { git -C "$1" rev-parse HEAD; }
ncm() { git -C "$1" rev-list --no-merges --count "$2..$3"; }
total() { git -C "$1" rev-list --count "$2..$3"; }

# an AWS-access-key-shaped random string; at least ten distinct characters so the entropy gate of the rule cannot make a test flaky
fake_secret() {
  local s
  while :; do
    s="$(LC_ALL=C tr -dc 'A-Z2-7' < /dev/urandom | head -c 16)"
    [ "$(printf '%s' "$s" | fold -w1 | sort -u | wc -l)" -ge 10 ] && break
  done
  printf '%s%s' 'AK' "IA$s"
}

# ---- the script under test, and a raw scanner used only to prove what the OLD action logic would have done -----------------------------------
sut() { # sut REPO VAR=value ...   (the script's own variables are cleared first, so nothing leaks in from the caller's environment)
  local r="$1"
  shift
  (cd "$r" && env -u EVENT_NAME -u PR_BASE_SHA -u PR_HEAD_SHA -u PR_COMMITS -u PUSH_BEFORE -u PUSH_AFTER -u GITLEAKS_BIN -u GITLEAKS_IMAGE \
    GITLEAKS_CONFIG="$CONFIG" "$@" bash "$SUT") > "$OUT" 2>&1
  RC=$?
  sed -i 's/\x1b\[[0-9;]*[A-Za-z]//g' "$OUT"
  SCANNED="$(grep -Eo 'gitleaks reported [0-9]+ commits scanned' "$OUT" | tail -1 | grep -Eo '[0-9]+')"
  SCANNED="${SCANNED:-none}"
}
sut_pr() { sut "$1" EVENT_NAME=pull_request PR_BASE_SHA="$2" PR_HEAD_SHA="$3" PR_COMMITS="$4"; }
sut_push() { sut "$1" EVENT_NAME=push PUSH_BEFORE="$2" PUSH_AFTER="$3"; }

raw_gitleaks() { # raw_gitleaks REPO LOG-OPTS -> RAW_RC, RAW_COUNT
  docker run --rm -v "$(hp "$1"):/repo:ro" -v "$(hp "$CONFIG"):/cfg/gitleaks.toml:ro" -e GIT_CONFIG_COUNT=1 -e GIT_CONFIG_KEY_0=safe.directory \
    -e GIT_CONFIG_VALUE_0=/repo "$IMG" git /repo --config /cfg/gitleaks.toml --log-opts="$2" --no-banner --redact --exit-code 2 > "$WORK/raw.out" 2>&1
  RAW_RC=$?
  sed -i 's/\x1b\[[0-9;]*[A-Za-z]//g' "$WORK/raw.out"
  RAW_COUNT="$(grep -Eo '[0-9]+ commits? scanned' "$WORK/raw.out" | tail -1 | grep -Eo '^[0-9]+')"
  RAW_COUNT="${RAW_COUNT:-none}"
  RC=$RAW_RC # the [exit= scanned=] tag printed with the next check describes THIS raw run
  SCANNED=$RAW_COUNT
}
# what gitleaks-action 2.3.9 did on a pull request: first 30 commits of the chronological listing, first and last of them, --no-merges --first-parent
old_action() { # old_action REPO BASE HEAD -> RAW_RC, RAW_COUNT
  local list first last
  list="$(git -C "$1" log --format='%ct %H' "$2..$3" | sort -n | head -30 | cut -d' ' -f2)"
  first="$(printf '%s\n' "$list" | head -1)"
  last="$(printf '%s\n' "$list" | tail -1)"
  raw_gitleaks "$1" "--no-merges --first-parent $first^..$last"
}

# merge-heavy integration branch shaped like PR 60: SIDES side branches off the base, each merged with a merge commit, plus a few linear commits.
# build_heavy REPO SIDES PER_SIDE SECRET_SIDE SECRET_INDEX   (SECRET_SIDE 0 = no secret). Sets BASE and HEAD.
build_heavy() {
  local r="$1" sides="$2" per="$3" ss="$4" si="$5" i j content
  cm "$r" README.md "base" "chore: base 1"
  cm "$r" docs/a.md "base two" "chore: base 2"
  BASE="$(head_of "$r")"
  git -C "$r" switch -q -c pr
  for i in $(seq 1 "$sides"); do
    git -C "$r" switch -q -c "side$i" "$BASE"
    for j in $(seq 1 "$per"); do
      content="side $i commit $j"
      if [ "$i" = "$ss" ] && [ "$j" = "$si" ]; then content="aws_access_key_id = $(fake_secret)"; fi
      cm "$r" "src/side$i-$j.conf" "$content" "feat: side $i part $j"
    done
    git -C "$r" switch -q pr
    mg "$r" "side$i" "chore(integration): merge side $i"
  done
  for j in 1 2 3; do cm "$r" "src/linear-$j.md" "linear $j" "docs: linear $j"; done
  HEAD="$(head_of "$r")"
}

# ---- the config guard (section 10): a scan with no effective detection rules must never be a pass ----------------------------------------------
# What a stub scanner prints when the gate asks it to scan the canary (`dir ...`): what the real v8.24.3 prints for a config that works.
CANARY_STUB_PRELUDE='[ "$1" = dir ] && { echo "RuleID:      github-pat"; echo "RuleID:      private-key"; echo "WRN leaks found: 2"; exit 2; }'

cfgfile() { # cfgfile NAME < config text  -> prints the path of the config file it wrote (never inside the repository under test)
  mkdir -p "$WORK/cfg"
  cat > "$WORK/cfg/$1.toml"
  printf '%s' "$WORK/cfg/$1.toml"
}
raw_with_cfg() { # raw_with_cfg REPO LOG-OPTS CONFIG -> RAW_RC, RAW_COUNT (the raw scanner with an explicit config: a witness of what the scanner alone does)
  local save="$CONFIG"
  CONFIG="$3"
  raw_gitleaks "$1" "$2"
  CONFIG="$save"
}
sut_cfg() { # sut_cfg REPO CONFIG BASE HEAD COMMITS
  sut "$1" EVENT_NAME=pull_request PR_BASE_SHA="$3" PR_HEAD_SHA="$4" PR_COMMITS="$5" GITLEAKS_CONFIG="$2"
}

section_config_guard() {
  local R CL PB PH CB CH F WHY S
  echo "== 10. config guard: a scan with no effective detection rules is never a pass (pinned scanner, disposable repos, planted fake secret)"
  R="$(mk cfg-planted)"
  cm "$R" README.md "base" "chore: base"
  PB="$(head_of "$R")"
  cm "$R" src/aws.conf "aws_access_key_id = $(fake_secret)" "feat: add aws config"
  PH="$(head_of "$R")"
  CL="$(mk cfg-clean)"
  cm "$CL" README.md "base" "chore: base"
  CB="$(head_of "$CL")"
  cm "$CL" src/a.md "one" "docs: one"
  CH="$(head_of "$CL")"

  sut_cfg "$R" "$CONFIG" "$PB" "$PH" 1
  chk "control: the repository's own config + a planted fake secret: exit 2, the config check ran first, 1 leak, 1 commit scanned" '[ $RC -eq 2 ] && [ "$SCANNED" = 1 ] && has "config check:" && has "leaks found: 1"'
  sut_cfg "$CL" "$CONFIG" "$CB" "$CH" 1
  chk "control: the repository's own config on a clean range: exit 0, and the canary secrets are never printed to the log" '[ $RC -eq 0 ] && has "config check:" && has "gitleaks-scan: OK" && ! has "ghp_" && ! has "PRIVATE KEY"'

  # witnesses: the scanner ALONE, given a config with no effective rules, scans the planted secret and says clean. This is the defect.
  F="$(cfgfile w-empty < /dev/null)"
  raw_with_cfg "$R" "$PB..$PH" "$F"
  chk "defect witness 1: the pinned scanner with an EMPTY config scans the planted-secret commit and exits 0 (so it would have passed)" '[ "$RAW_RC" -eq 0 ] && [ "$RAW_COUNT" = 1 ]'
  F="$(
    cfgfile w-allowlist-only << 'EOF'
[allowlist]
description = "fixtures"
paths = ['''.*\.test\.ts$''']
EOF
  )"
  raw_with_cfg "$R" "$PB..$PH" "$F"
  chk "defect witness 2: an allowlist WITHOUT [extend] useDefault = true (no rules at all): exit 0 on the planted secret" '[ "$RAW_RC" -eq 0 ] && [ "$RAW_COUNT" = 1 ]'
  F="$(
    cfgfile w-allow-all << 'EOF'
[extend]
useDefault = true
[allowlist]
paths = ['''.*''']
EOF
  )"
  raw_with_cfg "$R" "$PB..$PH" "$F"
  chk "defect witness 3: the default rules plus an allowlist that covers every path: exit 0 on the planted secret" '[ "$RAW_RC" -eq 0 ] && [ "$RAW_COUNT" = 1 ]'

  # the gate: every config that leaves the scanner blind is refused BEFORE the range is scanned, with the right reason, even with a planted secret
  bad_cfg() { # bad_cfg DESCRIPTION CONFIG-FILE REASON
    WHY="$3"
    sut_cfg "$R" "$2" "$PB" "$PH" 1
    chk "$1: exit 1, reason '$3', no success verdict, the range was never scanned" '[ $RC -eq 1 ] && has "FAIL:" && has "$WHY" && ! has "gitleaks-scan: OK" && ! has "no leaks found" && [ "$SCANNED" = none ]'
  }
  F="$(cfgfile empty < /dev/null)"
  bad_cfg "an EMPTY config (0 bytes), planted secret in range" "$F" "gitleaks config is empty"
  F="$(printf '  \n\t\n\n' | cfgfile blank)"
  bad_cfg "a config of blank lines only" "$F" "only blank lines and comments"
  F="$(printf '# nothing but comments\n# a second comment\n' | cfgfile comments)"
  bad_cfg "a COMMENTS-ONLY config" "$F" "only blank lines and comments"
  F="$(printf 'title = "x"\n' | cfgfile title)"
  bad_cfg "a config that sets only a title (valid TOML, no rules)" "$F" "detects nothing"
  F="$(
    cfgfile allowlist-only << 'EOF'
title = "fixtures only"
[allowlist]
description = "fixtures"
paths = ['''.*\.test\.ts$''']
EOF
  )"
  bad_cfg "an ALLOWLIST-ONLY config (the documented fixture allowlist without the rules it belongs to)" "$F" "detects nothing"
  F="$(
    cfgfile allow-all-paths << 'EOF'
[extend]
useDefault = true
[allowlist]
paths = ['''.*''']
EOF
  )"
  bad_cfg "default rules, but an allowlist covering every path" "$F" "detects nothing"
  F="$(
    cfgfile allow-all-regex << 'EOF'
[extend]
useDefault = true
[allowlist]
regexes = ['''.*''']
EOF
  )"
  bad_cfg "default rules, but an allowlist regex matching every secret" "$F" "detects nothing"
  F="$(
    cfgfile disabled-both << 'EOF'
[extend]
useDefault = true
disabledRules = ["github-pat", "private-key"]
EOF
  )"
  bad_cfg "default rules with the canary rules disabled" "$F" "detects nothing"
  F="$(
    cfgfile disabled-one << 'EOF'
[extend]
useDefault = true
disabledRules = ["private-key"]
EOF
  )"
  bad_cfg "default rules with ONE canary rule (private-key) disabled" "$F" "does not detect the canary for rule 'private-key'"
  F="$(
    cfgfile custom-only << 'EOF'
[[rules]]
id = "only-custom"
regex = '''NEVERMATCHES[0-9]{30}'''
EOF
  )"
  bad_cfg "a single custom rule that never fires and no default rules" "$F" "detects nothing"
  F="$(printf '[extend\nuseDefault = true\n' | cfgfile invalid)"
  bad_cfg "an INVALID config (broken TOML)" "$F" "could not use this config"

  # configs that work are still accepted, and a documented fixture allowlist still works beside the default rules
  F="$(printf '[extend]\nuseDefault = true\n' | cfgfile extend-only)"
  sut_cfg "$CL" "$F" "$CB" "$CH" 1
  chk "valid: [extend] useDefault = true alone, clean range: exit 0 and 1 commit scanned" '[ $RC -eq 0 ] && [ "$SCANNED" = 1 ] && has "config check:"'
  sut_cfg "$R" "$F" "$PB" "$PH" 1
  chk "valid: the same config on the planted-secret range: exit 2, 1 leak (a working config reports it)" '[ $RC -eq 2 ] && has "leaks found: 1"'
  F="$(
    cfgfile narrow-allowlist << 'EOF'
[extend]
useDefault = true
[allowlist]
paths = ['''.*\.test\.ts$''']
EOF
  )"
  S="$(mk cfg-allow-test)"
  cm "$S" README.md "base" "chore: base"
  CB="$(head_of "$S")"
  cm "$S" src/pay.test.ts "const k = '$(fake_secret)'" "test: fake key in a test file"
  CH="$(head_of "$S")"
  sut_cfg "$S" "$F" "$CB" "$CH" 1
  chk "valid: a documented fixture allowlist next to the default rules still exempts a *.test.ts file: exit 0, 1 commit scanned" '[ $RC -eq 0 ] && [ "$SCANNED" = 1 ]'
  S="$(mk cfg-allow-src)"
  cm "$S" README.md "base" "chore: base"
  CB="$(head_of "$S")"
  cm "$S" src/pay.ts "const k = '$(fake_secret)'" "feat: the same value in a source file"
  CH="$(head_of "$S")"
  sut_cfg "$S" "$F" "$CB" "$CH" 1
  chk "valid: ... and the same value in a normal source file is still reported: exit 2 (the allowlist was not widened)" '[ $RC -eq 2 ] && has "leaks found: 1"'

  # stub scanners that lie about the config: the gate must not trust a scanner that cannot prove it detects
  S="$(mk cfg-stub)"
  cm "$S" README.md "base" "chore: base"
  CB="$(head_of "$S")"
  cm "$S" src/a.md "one" "docs: one"
  cm "$S" src/b.md "two" "docs: two"
  CH="$(head_of "$S")"
  gstub() { # gstub NAME BODY (written exactly as given: no canary prelude)
    printf '#!/bin/sh\n%s\n' "$2" > "$WORK/$1.sh"
    chmod +x "$WORK/$1.sh"
  }
  gstub g-blind '[ "$1" = dir ] && { echo "INF no leaks found"; exit 0; }; echo "INF 2 commits scanned."; echo "INF no leaks found"; exit 0'
  sut "$S" EVENT_NAME=pull_request PR_BASE_SHA="$CB" PR_HEAD_SHA="$CH" PR_COMMITS=2 GITLEAKS_BIN="$WORK/g-blind.sh"
  chk "a scanner that finds nothing in the canary but then reports the FULL range scanned and clean: exit 1, never OK (a rule-less scan cannot pass)" '[ $RC -eq 1 ] && has "detects nothing" && ! has "gitleaks-scan: OK" && [ "$SCANNED" = none ]'
  gstub g-one-rule '[ "$1" = dir ] && { echo "RuleID:      github-pat"; echo "WRN leaks found: 1"; exit 2; }; echo "INF 2 commits scanned."; exit 0'
  sut "$S" EVENT_NAME=pull_request PR_BASE_SHA="$CB" PR_HEAD_SHA="$CH" PR_COMMITS=2 GITLEAKS_BIN="$WORK/g-one-rule.sh"
  chk "a scanner whose canary run fires only github-pat: exit 1, reason names the missing rule 'private-key'" '[ $RC -eq 1 ] && has "rule '"'"'private-key'"'"'" && ! has "gitleaks-scan: OK"'
  gstub g-exit2-no-rules '[ "$1" = dir ] && { echo "WRN leaks found: 1"; exit 2; }; echo "INF 2 commits scanned."; exit 0'
  sut "$S" EVENT_NAME=pull_request PR_BASE_SHA="$CB" PR_HEAD_SHA="$CH" PR_COMMITS=2 GITLEAKS_BIN="$WORK/g-exit2-no-rules.sh"
  chk "a scanner that exits 2 on the canary but names no rule (a crash, not a detection): exit 1, not accepted" '[ $RC -eq 1 ] && has "does not detect the canary for rule" && ! has "gitleaks-scan: OK"'
  gstub g-canary-error '[ "$1" = dir ] && { echo "FTL unable to load gitleaks config"; exit 1; }; echo "INF 2 commits scanned."; exit 0'
  sut "$S" EVENT_NAME=pull_request PR_BASE_SHA="$CB" PR_HEAD_SHA="$CH" PR_COMMITS=2 GITLEAKS_BIN="$WORK/g-canary-error.sh"
  chk "a scanner that errors on the canary (exit 1): exit 1, reason 'could not use this config'" '[ $RC -eq 1 ] && has "could not use this config" && ! has "gitleaks-scan: OK"'
  gstub g-works "$CANARY_STUB_PRELUDE"'; echo "INF 2 commits scanned."; echo "INF no leaks found"; exit 0'
  sut "$S" EVENT_NAME=pull_request PR_BASE_SHA="$CB" PR_HEAD_SHA="$CH" PR_COMMITS=2 GITLEAKS_BIN="$WORK/g-works.sh"
  chk "control: a scanner that detects both canary rules and then scans the full range clean: exit 0" '[ $RC -eq 0 ] && [ "$SCANNED" = 2 ] && has "config check:"'
}

echo "### gitleaks-scan.sh tests: image=${IMG:-<none found in the script>}"
echo "### config under test: $CONFIG"
if [ ! -f "$SUT" ]; then
  echo "  FAIL  the script under test exists ($SUT)"
  echo "### gitleaks-scan tests: PASS=0 FAIL=1"
  exit 1
fi
[ -n "$IMG" ] || {
  echo "  FAIL  the script pins gitleaks by digest"
  exit 1
}
if [ "${GATE_TEST_ONLY:-}" = config ]; then # a fast run of section 10 alone (used by the mutation sweep); CI runs everything
  section_config_guard
  echo "### gitleaks-scan tests (section 10 only): PASS=$PASS FAIL=$FAIL"
  [ "$FAIL" -eq 0 ]
  exit
fi

echo "== 0. the planted fake secret is detectable by raw gitleaks (a control for every detection test below)"
R="$(mk ctl)"
cm "$R" README.md "x" "chore: init"
cm "$R" src/aws.conf "aws_access_key_id = $(fake_secret)" "feat: add aws config"
raw_gitleaks "$R" "-1"
RC=$RAW_RC
SCANNED=$RAW_COUNT
chk "raw gitleaks exits 2 on the planted fake secret (so a clean result elsewhere is not a blind scanner)" '[ "$RAW_RC" -eq 2 ]'

echo "== 1. small pull request"
R="$(mk small)"
cm "$R" README.md "base" "chore: base"
B="$(head_of "$R")"
cm "$R" src/a.md "one" "docs: one"
cm "$R" src/b.md "two" "docs: two"
cm "$R" src/c.md "three" "docs: three"
H="$(head_of "$R")"
sut_pr "$R" "$B" "$H" 3
chk "clean 3-commit PR: exit 0 and all 3 commits scanned" '[ $RC -eq 0 ] && [ "$SCANNED" = 3 ] && has "scanned 3 of 3 scannable commits"'
R="$(mk small-leak)"
cm "$R" README.md "base" "chore: base"
B="$(head_of "$R")"
cm "$R" src/a.md "one" "docs: one"
SECRET="$(fake_secret)"
cm "$R" src/aws.conf "aws_access_key_id = $SECRET" "feat: add aws config"
cm "$R" src/c.md "three" "docs: three"
H="$(head_of "$R")"
sut_pr "$R" "$B" "$H" 3
chk "3-commit PR with a planted fake secret in the middle commit: exit 2, 1 leak reported, all 3 scanned" '[ $RC -eq 2 ] && [ "$SCANNED" = 3 ] && has "leaks found: 1"'
chk "the finding is diagnosable in the log (rule, file and commit are printed) ..." 'has "RuleID:" && has "File:" && has "src/aws.conf" && has "Commit:"'
chk "... and the planted secret value itself is NEVER printed (redacted)" '! grep -qF -- "$SECRET" "$OUT" && has "REDACTED"'
R="$(mk single)"
cm "$R" README.md "base" "chore: base"
B="$(head_of "$R")"
cm "$R" src/a.md "one" "docs: one"
H="$(head_of "$R")"
sut_pr "$R" "$B" "$H" 1
chk "one-commit PR (the smallest non-empty range): exit 0 and 1 commit scanned" '[ $RC -eq 0 ] && [ "$SCANNED" = 1 ]'

echo "== 2. more than 30 commits, linear"
R="$(mk linear45)"
cm "$R" README.md "base" "chore: base"
B="$(head_of "$R")"
for i in $(seq 1 45); do cm "$R" "src/f$i.md" "file $i" "docs: file $i"; done
H="$(head_of "$R")"
sut_pr "$R" "$B" "$H" 45
chk "45-commit PR: exit 0 and all 45 scanned (the old action listed only the first 30)" '[ $RC -eq 0 ] && [ "$SCANNED" = 45 ]'
R="$(mk linear45-leak)"
cm "$R" README.md "base" "chore: base"
B="$(head_of "$R")"
for i in $(seq 1 44); do cm "$R" "src/f$i.md" "file $i" "docs: file $i"; done
cm "$R" src/aws.conf "aws_access_key_id = $(fake_secret)" "feat: add aws config as commit 45"
H="$(head_of "$R")"
sut_pr "$R" "$B" "$H" 45
chk "a planted fake secret in commit 45 of 45 (past the old 30-commit page) is detected: exit 2" '[ $RC -eq 2 ] && [ "$SCANNED" = 45 ] && has "leaks found: 1"'

echo "== 3. merge-heavy integration branch (the shape of PR 60: first-parent chain is merges only)"
R="$(mk heavy)"
build_heavy "$R" 12 3 0 0
NCM="$(ncm "$R" "$BASE" "$HEAD")"
ALL="$(total "$R" "$BASE" "$HEAD")"
sut_pr "$R" "$BASE" "$HEAD" "$ALL"
chk "clean merge-heavy PR ($ALL commits, $NCM non-merge): exit 0 and all $NCM scanned" '[ $RC -eq 0 ] && [ "$SCANNED" = "$NCM" ]'
CLEAN_RC=$RC
old_action "$R" "$BASE" "$HEAD"
chk "regression witness: the OLD action logic scans fewer than $NCM here (it scanned $RAW_COUNT) and still exits 0, so this fixture reproduces the defect" '[ "$RAW_RC" -eq 0 ] && [ "$RAW_COUNT" != none ] && [ "$RAW_COUNT" -lt "$NCM" ]'
R="$(mk heavy-leak)"
build_heavy "$R" 12 3 12 2
NCM="$(ncm "$R" "$BASE" "$HEAD")"
ALL="$(total "$R" "$BASE" "$HEAD")"
sut_pr "$R" "$BASE" "$HEAD" "$ALL"
chk "a planted fake secret on the LAST merged side branch (reachable only through a second parent) is detected: exit 2" '[ $RC -eq 2 ] && [ "$SCANNED" = "$NCM" ] && has "leaks found: 1"'
OLD_SAW_LEAK=none
old_action "$R" "$BASE" "$HEAD"
chk "regression witness: the OLD action logic does NOT see that secret (exit $RAW_RC, scanned $RAW_COUNT of $NCM)" '[ "$RAW_RC" -eq 0 ]'
R="$(mk small-merge-leak)"
cm "$R" README.md "base" "chore: base"
B="$(head_of "$R")"
git -C "$R" switch -q -c side
cm "$R" src/aws.conf "aws_access_key_id = $(fake_secret)" "feat: side branch adds aws config"
git -C "$R" switch -q main
cm "$R" src/main-side.md "x" "docs: a commit on the PR branch"
mg "$R" side "chore: merge side"
H="$(head_of "$R")"
sut_pr "$R" "$B" "$H" "$(total "$R" "$B" "$H")"
chk "even a SMALL PR (3 commits) with a merged side branch: the secret on the side branch is detected: exit 2" '[ $RC -eq 2 ]'
old_action "$R" "$B" "$H"
chk "regression witness: the OLD logic misses it on this small PR too (--first-parent skips the side branch): exit $RAW_RC" '[ "$RAW_RC" -eq 0 ]'
R="$(mk added-then-removed)"
cm "$R" README.md "base" "chore: base"
B="$(head_of "$R")"
cm "$R" src/aws.conf "aws_access_key_id = $(fake_secret)" "feat: add aws config"
cm "$R" src/aws.conf "aws_access_key_id = removed" "fix: remove the key again"
H="$(head_of "$R")"
sut_pr "$R" "$B" "$H" 2
chk "a secret added and removed inside the same PR is still in history and is detected: exit 2" '[ $RC -eq 2 ] && [ "$SCANNED" = 2 ]'

echo "== 4. documented fixture allowlists are honoured, and not widened"
R="$(mk allow)"
cm "$R" README.md "base" "chore: base"
B="$(head_of "$R")"
cm "$R" src/payments.test.ts "const key = '$(fake_secret)'" "test: a fake key inside a test file"
H="$(head_of "$R")"
sut_pr "$R" "$B" "$H" 1
chk "the same kind of fake value inside a *.test.ts file (an allowlisted path) is NOT reported: exit 0, 1 scanned" '[ $RC -eq 0 ] && [ "$SCANNED" = 1 ]'
R="$(mk allow-control)"
cm "$R" README.md "base" "chore: base"
B="$(head_of "$R")"
cm "$R" src/payments.ts "const key = '$(fake_secret)'" "feat: the same value in a normal source file"
H="$(head_of "$R")"
sut_pr "$R" "$B" "$H" 1
chk "the same value in a normal source file IS reported: exit 2 (the allowlist covers the documented path only)" '[ $RC -eq 2 ] && has "leaks found: 1"'
R="$(mk allow-fixtures-dir)"
cm "$R" README.md "base" "chore: base"
B="$(head_of "$R")"
cm "$R" packages/config/fixtures/sample.txt "aws_access_key_id = $(fake_secret)" "test: a fixture"
H="$(head_of "$R")"
sut_pr "$R" "$B" "$H" 1
chk "the documented packages/config/fixtures/ path is honoured: exit 0" '[ $RC -eq 0 ] && [ "$SCANNED" = 1 ]'
# The documented fake test password is assembled at run time so that it never appears as a literal in this file (this file is NOT an allowlisted path).
FIXTURE_PW="Correct""Horse""Battery""Staple9"
if grep -qF -- "$FIXTURE_PW" "$CONFIG"; then
  R="$(mk allow-patch)"
  cm "$R" README.md "base" "chore: base"
  B="$(head_of "$R")"
  cm "$R" docs/decisions/sample.patch "+const FIXTURE_PASSWORD = '$FIXTURE_PW';" "docs: an approval patch with the documented fake password"
  H="$(head_of "$R")"
  sut_pr "$R" "$B" "$H" 1
  chk "the documented fake test password inside an approval .patch is NOT reported: exit 0" '[ $RC -eq 0 ] && [ "$SCANNED" = 1 ]'
  R="$(mk allow-patch-control)"
  cm "$R" README.md "base" "chore: base"
  B="$(head_of "$R")"
  cm "$R" src/other.ts "const FIXTURE_PASSWORD = '$FIXTURE_PW';" "feat: the same value outside a .patch"
  H="$(head_of "$R")"
  sut_pr "$R" "$B" "$H" 1
  chk "the same value outside a .patch IS reported: exit 2 (the exception was not widened)" '[ $RC -eq 2 ]'
else
  echo "  N/A   approval-patch fixture checks: this config has no exception for the documented fake test password (it arrives with PR 47); run with GITLEAKS_CONFIG pointing at that config to execute them"
fi

echo "== 5. real history of this repository (needs the full checkout CI uses: fetch-depth 0)"
M=ea56cffca0586fc7279dc35d886af69cd3fbab78
if git -C "$ROOT" cat-file -e "$M^{commit}" 2> /dev/null; then
  P="$(git -C "$ROOT" rev-parse "$M^1")"
  NCM="$(ncm "$ROOT" "$P" "$M")"
  ALL="$(total "$ROOT" "$P" "$M")"
  sut_pr "$ROOT" "$P" "$M" "$ALL"
  chk "real merged PR #38 ($ALL commits, $NCM non-merge) from this repository's own history: exit 0 and all $NCM scanned" '[ $RC -eq 0 ] && [ "$SCANNED" = "$NCM" ]'
  sut_push "$ROOT" "$P" "$M"
  chk "the same range as a push event: exit 0 and all $NCM scanned" '[ $RC -eq 0 ] && [ "$SCANNED" = "$NCM" ]'
else
  RC=n/a
  SCANNED=n/a
  bad "the real merged PR #38 commit is present (is this a full checkout?)"
fi

echo "== 6. invalid or unresolvable base and head (every one must FAIL CLOSED with exit 1 and no success line)"
R="$(mk invalid)"
cm "$R" README.md "base" "chore: base"
B="$(head_of "$R")"
cm "$R" src/a.md "one" "docs: one"
H="$(head_of "$R")"
ZERO=0000000000000000000000000000000000000000
MISSING=1111111111111111111111111111111111111111
inv() { # inv NAME EXPECTED-REASON BASE HEAD COMMITS: exit 1, no success verdict, and the failure names the RIGHT reason
  WHY="$2"
  sut_pr "$R" "$3" "$4" "$5"
  chk "$1: exit 1, no success verdict, reason '$2'" '[ $RC -eq 1 ] && has "FAIL:" && has "$WHY" && ! has "gitleaks-scan: OK"'
}
inv "base is a branch name, not a SHA" "base is not a full 40-character" main "$H" 1
inv "base is a short SHA" "base is not a full 40-character" "${B:0:7}" "$H" 1
inv "base is empty" "base is not a full 40-character" "" "$H" 1
inv "head is empty" "head is not a full 40-character" "$B" "" 1
inv "base is a well-formed SHA that does not exist" "is not a commit in this clone" "$MISSING" "$H" 1
inv "head is a well-formed SHA that does not exist" "is not a commit in this clone" "$B" "$MISSING" 1
inv "head is the all-zero SHA" "head is not a full 40-character" "$B" "$ZERO" 1
inv "base and head are swapped (head is an ancestor of base: empty range)" "is empty (0 commits)" "$H" "$B" 1
inv "payload commit count is missing" "commit count from the event payload is missing" "$B" "$H" ""
inv "payload commit count is not a number" "commit count from the event payload is missing" "$B" "$H" many

echo "== 7. empty, truncated and inconsistent ranges"
R="$(mk empty)"
cm "$R" README.md "base" "chore: base"
B="$(head_of "$R")"
cm "$R" src/a.md "one" "docs: one"
cm "$R" src/b.md "two" "docs: two"
H="$(head_of "$R")"
sut_pr "$R" "$H" "$H" 2
chk "base == head with a payload that says 2 commits: exit 1, reason 'is empty' (an empty scan is never a pass)" '[ $RC -eq 1 ] && has "FAIL:" && has "is empty (0 commits)" && ! has "gitleaks-scan: OK"'
sut_pr "$R" "$H" "$H" 0
chk "base == head with a payload that says 0 commits: exit 1, reason 'is empty' (nothing was scanned)" '[ $RC -eq 1 ] && has "is empty (0 commits)" && ! has "gitleaks-scan: OK"'
sut_pr "$R" "$B" "$H" 5
chk "payload says 5 commits but git resolves 2 (truncated or inconsistent history): exit 1, reason names both numbers" '[ $RC -eq 1 ] && has "FAIL:" && has "says the pull request has 5 commits but git resolves 2"'
sut_pr "$R" "$B" "$H" 1
chk "payload says 1 commit but git resolves 2: exit 1 (the check is exact in both directions)" '[ $RC -eq 1 ] && has "says the pull request has 1 commits but git resolves 2"'
# a range made only of a merge commit has no authored diff to scan
cm "$R" src/c.md "three" "docs: three"
H2="$(head_of "$R")"
MERGE_ONLY="$(git -C "$R" commit-tree "$H2^{tree}" -p "$H2" -p "$B" -m "chore: merge only")"
sut_pr "$R" "$H2" "$MERGE_ONLY" 1
chk "a range that holds only a merge commit (nothing the scanner can read): exit 1, reason 'carries a diff'" '[ $RC -eq 1 ] && has "carries a diff the scanner can read" && ! has "gitleaks-scan: OK"'
R="$(mk emptycommit)"
cm "$R" README.md "base" "chore: base"
B="$(head_of "$R")"
cm "$R" src/a.md "one" "docs: one"
tick
GIT_AUTHOR_DATE="@$TS +0000" GIT_COMMITTER_DATE="@$TS +0000" git -C "$R" commit -q --allow-empty -m "chore: an empty commit (no diff to scan)"
cm "$R" src/b.md "two" "docs: two"
H="$(head_of "$R")"
sut_pr "$R" "$B" "$H" 3
chk "a PR holding an empty commit (3 commits, 2 with a diff): exit 0 and exactly the 2 scannable commits scanned" '[ $RC -eq 0 ] && [ "$SCANNED" = 2 ] && has "scanned 2 of 2 scannable commits"'
B="$(git -C "$R" rev-parse HEAD~2)"
SH="$WORK/shallow"
git clone -q --no-local --depth 1 "$R" "$SH" 2> /dev/null
[ "$(git -C "$SH" rev-parse --is-shallow-repository 2> /dev/null)" = true ] || echo "  NOTE  the shallow fixture is not shallow: the next check is not meaningful" >&2
sut_pr "$SH" "$B" "$H" 2
chk "a shallow clone (history truncated): exit 1, reason 'shallow'" '[ $RC -eq 1 ] && has "the clone is shallow"'
RMT="$WORK/notarepo"
mkdir -p "$RMT"
sut_pr "$RMT" "$B" "$H" 2
chk "run outside a git repository: exit 1, reason 'not inside a git repository'" '[ $RC -eq 1 ] && has "not inside a git repository"'

echo "== 8. other events"
R="$(mk push)"
cm "$R" README.md "base" "chore: base"
B="$(head_of "$R")"
cm "$R" src/a.md "one" "docs: one"
cm "$R" src/b.md "two" "docs: two"
H="$(head_of "$R")"
sut_push "$R" "$B" "$H"
chk "push event, clean 2-commit range (before..after): exit 0 and 2 scanned" '[ $RC -eq 0 ] && [ "$SCANNED" = 2 ]'
sut_push "$R" "$ZERO" "$H"
chk "push event on a brand-new branch (all-zero before): exit 1, the range cannot be resolved (reason names the brand-new branch)" '[ $RC -eq 1 ] && has "brand-new branch" && ! has "gitleaks-scan: OK"'
R2="$(mk push-leak)"
cm "$R2" README.md "base" "chore: base"
B2="$(head_of "$R2")"
cm "$R2" src/aws.conf "aws_access_key_id = $(fake_secret)" "feat: add aws config"
H2="$(head_of "$R2")"
sut_push "$R2" "$B2" "$H2"
chk "push event with a planted fake secret: exit 2" '[ $RC -eq 2 ]'
sut "$R" EVENT_NAME=workflow_dispatch PUSH_BEFORE="$B" PUSH_AFTER="$H" PR_BASE_SHA="$B" PR_HEAD_SHA="$H" PR_COMMITS=2
chk "an event the script does not know (workflow_dispatch), even with a valid range supplied: exit 1, reason 'unsupported event'" '[ $RC -eq 1 ] && has "unsupported event '"'"'workflow_dispatch'"'"'" && ! has "gitleaks-scan: OK"'
sut "$R" PUSH_BEFORE="$B" PUSH_AFTER="$H"
chk "no event at all, even with a valid range supplied: exit 1, reason 'unsupported event'" '[ $RC -eq 1 ] && has "unsupported event" && ! has "gitleaks-scan: OK"'

echo "== 9. configuration and scanner guards (the scanner is replaced by a stub that lies in specific ways)"
R="$(mk stub)"
cm "$R" README.md "base" "chore: base"
B="$(head_of "$R")"
cm "$R" src/a.md "one" "docs: one"
cm "$R" src/b.md "two" "docs: two"
H="$(head_of "$R")"
stub() { # stub NAME BODY (the gate first asks the scanner to scan its canary: every stub answers that like a scanner whose config works)
  printf '#!/bin/sh\n%s\n%s\n' "$CANARY_STUB_PRELUDE" "$2" > "$WORK/$1.sh"
  chmod +x "$WORK/$1.sh"
}
stub gl-zero 'echo "INF 0 commits scanned."; echo "INF no leaks found"; exit 0'
stub gl-short 'echo "INF 1 commits scanned."; echo "INF no leaks found"; exit 0'
stub gl-silent 'echo "INF no leaks found"; exit 0'
stub gl-error 'echo "ERR something broke"; exit 1'
stub gl-error-after-count 'echo "INF 2 commits scanned."; echo "ERR something broke at the end"; exit 1'
stub gl-good 'echo "INF 2 commits scanned."; echo "INF no leaks found"; exit 0'
stub gl-leak 'echo "INF 2 commits scanned."; echo "WRN leaks found: 3"; exit 2'
sut "$R" EVENT_NAME=pull_request PR_BASE_SHA="$B" PR_HEAD_SHA="$H" PR_COMMITS=2 GITLEAKS_BIN="$WORK/gl-good.sh"
chk "control: a scanner that reports the full count and no leaks passes: exit 0" '[ $RC -eq 0 ] && [ "$SCANNED" = 2 ]'
sut "$R" EVENT_NAME=pull_request PR_BASE_SHA="$B" PR_HEAD_SHA="$H" PR_COMMITS=2 GITLEAKS_BIN="$WORK/gl-zero.sh"
chk "a scanner that says '0 commits scanned' and exits 0 on a 2-commit PR: exit 1, reason 'scanned 0 commits' (the original defect, now caught)" '[ $RC -eq 1 ] && has "FAIL:" && has "scanned 0 commits: an empty scan is not a pass"'
sut "$R" EVENT_NAME=pull_request PR_BASE_SHA="$B" PR_HEAD_SHA="$H" PR_COMMITS=2 GITLEAKS_BIN="$WORK/gl-short.sh"
chk "a scanner that scanned 1 of 2 commits: exit 1, reason 'a partial scan is not a pass'" '[ $RC -eq 1 ] && has "a partial scan is not a pass"'
sut "$R" EVENT_NAME=pull_request PR_BASE_SHA="$B" PR_HEAD_SHA="$H" PR_COMMITS=2 GITLEAKS_BIN="$WORK/gl-silent.sh"
chk "a scanner that prints no commit count at all: exit 1, reason 'printed no commit count'" '[ $RC -eq 1 ] && has "printed no commit count"'
sut "$R" EVENT_NAME=pull_request PR_BASE_SHA="$B" PR_HEAD_SHA="$H" PR_COMMITS=2 GITLEAKS_BIN="$WORK/gl-error.sh"
chk "a scanner that errors (exit 1): the job fails with exit 1, reason 'the scanner exited with code 1'" '[ $RC -eq 1 ] && has "the scanner exited with code 1"'
sut "$R" EVENT_NAME=pull_request PR_BASE_SHA="$B" PR_HEAD_SHA="$H" PR_COMMITS=2 GITLEAKS_BIN="$WORK/gl-error-after-count.sh"
chk "a scanner that prints the FULL count and then exits 1: exit 1, reason 'the scanner exited with code 1' (the exit code is judged on its own)" '[ $RC -eq 1 ] && has "the scanner exited with code 1" && ! has "gitleaks-scan: OK"'
sut "$R" EVENT_NAME=pull_request PR_BASE_SHA="$B" PR_HEAD_SHA="$H" PR_COMMITS=2 GITLEAKS_BIN="$WORK/gl-leak.sh"
chk "a scanner that reports leaks (exit 2): the job fails with exit 2, reason 'LEAKS FOUND'" '[ $RC -eq 2 ] && has "LEAKS FOUND"'
sut "$R" EVENT_NAME=pull_request PR_BASE_SHA="$B" PR_HEAD_SHA="$H" PR_COMMITS=2 GITLEAKS_BIN="$WORK/does-not-exist"
chk "a scanner binary that does not exist: exit 1, reason 'GITLEAKS_BIN is not an executable file'" '[ $RC -eq 1 ] && has "GITLEAKS_BIN is not an executable file"'
sut "$R" EVENT_NAME=pull_request PR_BASE_SHA="$B" PR_HEAD_SHA="$H" PR_COMMITS=2 GITLEAKS_CONFIG="$WORK/no-such-config.toml"
chk "a missing config file: exit 1, reason 'gitleaks config not found' (never fall back to the default rules silently)" '[ $RC -eq 1 ] && has "gitleaks config not found" && ! has "gitleaks-scan: OK"'

section_config_guard

echo "### gitleaks-scan tests: PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
