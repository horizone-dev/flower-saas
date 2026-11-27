#!/bin/bash
# FLOWER SAAS - December alpha integration sequence. REHEARSAL ONLY: nothing is committed, pushed, merged or deployed by this script.
#
#   ./december-sequence.sh integrity            sha256 of every candidate patch against patches/SHA256SUMS (run from any checkout)
#   ./december-sequence.sh check                apply every approval-gated change IN ORDER onto the #49 tip with a temporary git index
#                                               (no working tree touched); stops at the first patch that does not apply
#   ./december-sequence.sh boundaries           each approval boundary applied ALONE on its own base (independence matrix), then the four
#                                               main-based boundaries cumulatively
#   ./december-sequence.sh materialise <dir>    the same sequence in a NEW disposable worktree <dir> (then: pnpm install --frozen-lockfile)
#   ./december-sequence.sh isolated <dir>       each main-based boundary ALONE in a worktree of origin/main (deps installed, packages built), its own tests
#   ./december-sequence.sh gates <dir>          the gates, run ONE AT A TIME in <dir> (tsc, structural, chunked suites, ESLint, Prettier)
#
# Run from any worktree of the Flower SaaS repo that contains this file at the revision in $DOCS (default: HEAD).
set -euo pipefail
export MSYS_NO_PATHCONV=1
MAIN_REV="${MAIN_REV:-origin/main}"
BASE_REV="${BASE_REV:-origin/phase-4/pr8-ci-workflows}"   # the #49 tip = the merged state of #43 -> #44 -> #48 -> #49
F7A_REV="${F7A_REV:-origin/phase-4/f7a-staff-onboarding-inert}"  # #52 (inert F-7a), stacked on #43
DOCS="${DOCS-HEAD}"   # DOCS= (empty) reads the working tree instead of a commit
D=docs/decisions/proposed-migrations; P=$D/patches
F7A_FILES="staff-onboarding.integration.test.ts staff-onboarding.repository.ts staff-onboarding.service.ts staff-scope.test.ts staff-scope.ts"
R1TEST="$P/R1-disabled-vault.integration.test.ts.txt"; R1DEST=apps/api/src/modules/secrets/r1-disabled-vault.integration.test.ts

# boundary table: <id>|<base: main|stack>|<patch path>
B_R1="R-1  production-mode fail-closed vault|main|$P/R1-secrets-disabled-provider.patch"
B_F6="F-6  VAT fail-closed (frozen-contract amendment)|main|$P/F6-vat-server-amendment-FULL.patch"
B_M1="M-1  MFA enrol guard|main|$P/M1-mfa-enrol-guard.patch"
B_F1A="F-1a cashier/sales catalog:view (role templates)|main|$D/DRAFT-F1-system-roles.patch"
B_F1P="F-1  six frozen-pin hash amendment (needs F-1a)|main|$P/F1-six-pin-hash-amendment.patch"
B_F7B="F-7b staff-invite route A + #48 bootstrap-test correction|stack|$P/F7b-activation.candidate.v2.patch"
B_F7C="F-7c manager allow-list (needs F-7b)|stack|$P/F7c-manager-onboarding.candidate.patch"
B_GATE="F-7c manager MFA enrolment gate (needs F-7c)|stack|$P/F7c-mfa-gate.candidate.patch"
SEQUENCE=("$B_R1" "$B_F6" "$B_M1" "$B_F1A" "$B_F1P" "$B_F7B" "$B_F7C" "$B_GATE")

T="$(mktemp -d)"; TW="$(cygpath -m "$T")"; trap 'rm -rf "$T"' EXIT
ROOT="$(git rev-parse --show-toplevel)"
doc() { if [ -z "$DOCS" ]; then cat "$ROOT/$1"; else git show "$DOCS:$1"; fi; }   # DOCS= reads the working tree
put_r1_test() { h=$(doc "$R1TEST" | git hash-object -w --stdin); git update-index --add --cacheinfo 100644,"$h",$R1DEST; }
seed_stack() { for f in $F7A_FILES; do h=$(git show "$F7A_REV:apps/api/src/modules/access/$f" | git hash-object -w --stdin)
                 git update-index --add --cacheinfo 100644,"$h",apps/api/src/modules/access/"$f"; done; }
apply_idx() { # <label|base|path> -> applies to the current temp index; returns non-zero on failure
  local label path; label="${1%%|*}"; path="${1##*|}"; doc "$path" > "$TW/p.patch"
  if git apply --cached "$TW/p.patch" 2>"$TW/err"; then echo "OK   $label"; [[ "$label" == R-1* ]] && put_r1_test; return 0
  else echo "FAIL $label"; sed 's/^/       /' "$TW/err" | head -5; return 1; fi; }
fresh_index() { export GIT_INDEX_FILE="$TW/idx"; rm -f "$T/idx"; git read-tree "$1"; }

case "${1:-}" in
integrity)
  doc $P/SHA256SUMS > "$TW/sums"; ok=0
  while read -r want name; do name="${name#\*}"; got=$(doc "$P/$name" | sha256sum | cut -d' ' -f1)
    if [ "$want" = "$got" ]; then echo "OK   $name"; else echo "FAIL $name (expected ${want:0:12}, got ${got:0:12})"; ok=1; fi; done < "$TW/sums"
  [ $ok = 0 ] && echo "ALL PATCHES MATCH SHA256SUMS" || { echo "INTEGRITY FAILURE"; exit 1; } ;;
check)
  fresh_index "$BASE_REV"; seed_stack; echo "OK   0  #52 F-7a (inert) files on the #49 tip"
  for step in "${SEQUENCE[@]}"; do apply_idx "$step" || exit 1; done
  git diff --cached --stat "$BASE_REV" | tail -1; echo "SEQUENCE APPLIES CLEANLY IN ORDER" ;;
boundaries)
  echo "== each boundary ALONE on its own base (F-1 pins and F-7c/gate need their predecessor, shown with it)"
  for step in "$B_R1" "$B_F6" "$B_M1" "$B_F1A"; do fresh_index "$MAIN_REV"; apply_idx "$step" || exit 1; done
  fresh_index "$MAIN_REV"; apply_idx "$B_F1A" >/dev/null; apply_idx "$B_F1P" || exit 1
  fresh_index "$BASE_REV"; seed_stack; apply_idx "$B_F7B" || exit 1
  apply_idx "$B_F7C" || exit 1; apply_idx "$B_GATE" || exit 1
  echo "== the four main-based boundaries together, on origin/main (they must not overlap)"
  fresh_index "$MAIN_REV"; for step in "$B_R1" "$B_F6" "$B_M1" "$B_F1A" "$B_F1P"; do apply_idx "$step" || exit 1; done
  echo "== files touched per boundary (against its own base)"
  for step in "$B_R1" "$B_F6" "$B_M1" "$B_F1A"; do fresh_index "$MAIN_REV"; apply_idx "$step" >/dev/null
    echo "   ${step%%|*}: $(git diff --cached --name-only "$MAIN_REV" | wc -l) files"; done
  echo "BOUNDARIES INDEPENDENT AS DOCUMENTED" ;;
materialise)
  W="${2:?target dir (must not exist)}"; git worktree add --detach "$W" "$BASE_REV"
  (cd "$W"; for f in $F7A_FILES; do git checkout "$F7A_REV" -- apps/api/src/modules/access/$f; done
   for step in "${SEQUENCE[@]}"; do label="${step%%|*}"; doc "${step##*|}" > "$TW/p.patch"; git apply "$TW/p.patch"; echo "applied $label"
     [[ "$label" == R-1* ]] && doc "$R1TEST" > $R1DEST; true; done)
  echo "materialised in $W (run: pnpm install --frozen-lockfile there, then: $0 gates $W)" ;;
isolated)
  # <dir> = a worktree of origin/main with dependencies installed and `pnpm -r --filter "./packages/*" build` done (NOT the #49 stack).
  # Applies each main-based boundary ALONE, runs ITS tests, and restores the tree before the next one. One heavy run at a time.
  W="${2:?clean origin/main worktree}"; export NODE_OPTIONS=--max-old-space-size=3072
  restore() { (cd "$W"; git checkout -q -- .; git clean -fdq -- apps packages 2>/dev/null; true); }
  FILTER="${3:-}"; want() { [ -z "$FILTER" ] || [ "$FILTER" = "$1" ]; }   # optional 3rd argument: r1 | f6 | m1 | f1a | pins (run one step only)
  run_alone() { # <label> <patch path> <place-r1-test 0|1> <vitest args...>
    local label="$1" path="$2" r1="$3"; shift 3; echo "######## $label"; restore
    (cd "$W"; doc "$path" > "$TW/p.patch"; git apply "$TW/p.patch"; [ "$r1" = 1 ] && doc "$R1TEST" > $R1DEST
     cd apps/api; { pnpm exec vitest run "$@" --no-file-parallelism 2>&1 | grep -E "Test Files|Tests |FAIL|Error"; } || true)
    restore
  }
  want r1 && run_alone "R-1 alone" "$P/R1-secrets-disabled-provider.patch" 1 src/config src/modules/secrets
  want f6 && run_alone "F-6 alone" "$P/F6-vat-server-amendment-FULL.patch" 0 src/modules/catalog/catalog-company-pricing.integration.test.ts \
    src/modules/catalog/catalog-identifiers.integration.test.ts src/modules/catalog/catalog-uom.integration.test.ts src/modules/catalog/catalog-variants.integration.test.ts \
    src/modules/catalog/variant-tax-fail-closed.integration.test.ts src/modules/orders/order.controller.integration.test.ts src/modules/orders/f6-vat-server.integration.test.ts \
    src/modules/sales/task-3b9-checkpoint-d-structural.test.ts
  want m1 && run_alone "M-1 alone" "$P/M1-mfa-enrol-guard.patch" 0 src/modules/identity
  want f1a && echo "######## F-1a alone, WITHOUT the pin amendment (the six pins must FAIL: that is why the amendment is a separate reviewed boundary)"
  want f1a && run_alone "F-1a alone" "$D/DRAFT-F1-system-roles.patch" 0 src/modules/reporting/task-3b10-checkpoint-a-structural.test.ts \
    src/modules/reporting/task-3b10-checkpoint-b-structural.test.ts src/modules/reporting/task-3b10-checkpoint-c-structural.test.ts \
    src/modules/reporting/task-3b10-checkpoint-d-structural.test.ts src/modules/reporting/task-3b10-checkpoint-e-structural.test.ts \
    src/modules/reporting/task-3b10-checkpoint-f-structural.test.ts
  if want pins; then echo "######## F-1a + six-pin amendment"; restore
  (cd "$W"; doc "$D/DRAFT-F1-system-roles.patch" > "$TW/p.patch"; git apply "$TW/p.patch"; doc "$P/F1-six-pin-hash-amendment.patch" > "$TW/p.patch"; git apply "$TW/p.patch"
   cd apps/api; { pnpm exec vitest run src/modules/reporting/task-3b10-checkpoint-a-structural.test.ts src/modules/reporting/task-3b10-checkpoint-b-structural.test.ts \
     src/modules/reporting/task-3b10-checkpoint-c-structural.test.ts src/modules/reporting/task-3b10-checkpoint-d-structural.test.ts \
     src/modules/reporting/task-3b10-checkpoint-e-structural.test.ts src/modules/reporting/task-3b10-checkpoint-f-structural.test.ts src/modules/platform --no-file-parallelism \
     2>&1 | grep -E "Test Files|Tests |FAIL|Error"; } || true)
  restore; fi ;;
gates)
  W="${2:?worktree}"; cd "$W/apps/api"; export NODE_OPTIONS=--max-old-space-size=3072
  echo "== tsc";        pnpm exec tsc --noEmit -p tsconfig.json
  echo "== structural + probes (15 files / 691 + probes 22)"
  pnpm exec vitest run $(find src -name '*structural*.test.ts') src/probes
  echo "== A: config, R-1 secrets, identity (M-1), access (F-7b/c + gate)"
  pnpm exec vitest run src/config src/modules/secrets src/modules/identity src/modules/access --no-file-parallelism
  echo "== B: catalog + orders (F-6), production-mode bootstrap"
  pnpm exec vitest run src/modules/catalog/catalog-company-pricing.integration.test.ts src/modules/catalog/catalog-identifiers.integration.test.ts \
    src/modules/catalog/catalog-uom.integration.test.ts src/modules/catalog/catalog-variants.integration.test.ts src/modules/catalog/variant-tax-fail-closed.integration.test.ts \
    src/modules/orders/order.controller.integration.test.ts src/modules/orders/f6-vat-server.integration.test.ts src/tooling --no-file-parallelism
  echo "== lint + format"; cd ../..; pnpm exec eslint apps/api/src; pnpm exec prettier --check apps/api/src/modules/access apps/api/src/modules/identity apps/pos-pwa/e2e
  echo "== browser journeys, one at a time (build the API first):"
  echo "   pnpm --filter @flower/api build && (cd apps/pos-pwa && E2E_FOCUS=pos node e2e/run.mjs)     # 13 browser + 134 DB checks"
  echo "   (cd apps/pos-pwa && E2E_FOCUS=owner node e2e/run.mjs)                                      # 8 browser + 14 DB checks" ;;
*) sed -n 2,14p "$0"; exit 2 ;;
esac
