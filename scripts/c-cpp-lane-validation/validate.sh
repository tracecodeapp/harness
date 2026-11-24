#!/usr/bin/env bash
# C-CPP lane: the whole remaining validation as one job on agentrunner.
#
#   1. regenerate both runtime asset locks (scope 1 head, then the provisional
#      judged-output cap restacked on it) as deterministic commits;
#   2. the C++ browser suites, with the natural-shape proof set and the A' tests;
#   3. pack the scope-1 pin, and capture the A' refusal sample from it;
#   4. GA C++ and GB C++ on the pin and, for the delta, on the step-7 pin
#      (main 571139f0's C++ worker and provider are byte-identical to step 7);
#   5. register the pin in /root/ci/coord-artifacts.
#
# Every step's exit status and duration go to OUT/steps.txt; a later step runs
# even when an earlier test step fails, but nothing runs without its inputs.
# Functional only: nothing here is timed for comparison.
#
# Usage, from a clean clone of /root/ci/harness.git checked out at the lane head
# (dependencies installed), under the host's heavy limiter:
#   heavy nice -n 10 ionice -c3 bash scripts/c-cpp-lane-validation/validate.sh \
#     OUT_DIR APP_STAGE_MANIFEST MUX_DIR
set -uo pipefail

out=$(realpath -m "${1:?OUT_DIR}")
app_manifest=$(realpath "${2:?APP_STAGE_MANIFEST}")
mux=$(realpath "${3:?MUX_DIR}")
root=$(git rev-parse --show-toplevel)
cd "$root"

# Pinned inputs.
expected_head=${C_CPP_EXPECTED_HEAD:-}
app_manifest_sha=52d79823668e5326018986bc887b58422407a48731cf0966b09e44b98e03a62f
mux_sha=82888fb7bc95272e43477ab5ae62b95cc28e9008
ga_gate=6c5c8768a007c64241b5ef85bb3fd1d5ad2fd3c0
gb_gate=a6c1485d9d165fe99861bc1028edc737d539edf5
cap_commits=(61bb9f40 e2c660d3)
base_subject=9b30ad9bc203ad2ba2f159d96dfaef62940262c7
base_pin=/root/ci/coord-artifacts/feat-b7-cpp-9b30ad9bc203.tgz
base_pin_sha=562612f2b8e9240181890a0d2a3493277d725dcc9d68546fcca40e664a5300b6
registry=/root/ci/coord-artifacts
# Lock commits are deterministic, so the same commit can be rebuilt off the host.
commit_date=${C_CPP_COMMIT_DATE:-2026-11-24T13:00:00Z}
author_name=$(git log -1 --format=%an)
author_email=$(git log -1 --format=%ae)

mkdir -p "$out/logs" "$out/evidence"
: > "$out/steps.txt"
failed=0

step() {
  local name=$1; shift
  local start=$SECONDS
  ( "$@" ) > "$out/logs/$name.log" 2>&1
  local code=$?
  printf '%s exit=%s seconds=%s\n' "$name" "$code" "$((SECONDS - start))" | tee -a "$out/steps.txt"
  [ "$code" = 0 ] || failed=1
  return "$code"
}

# Peak CPU and memory, sampled every 5 s.
( while :; do
    printf '%s load=%s mem_used_mb=%s\n' "$(date -u +%T)" "$(cut -d' ' -f1 /proc/loadavg)" \
      "$(free -m | awk '/^Mem:/ {print $3}')"
    sleep 5
  done ) > "$out/resources.txt" 2>/dev/null &
sampler=$!
trap 'kill "$sampler" 2>/dev/null' EXIT

deterministic_commit() {
  GIT_AUTHOR_NAME="$author_name" GIT_AUTHOR_EMAIL="$author_email" GIT_AUTHOR_DATE="$commit_date" \
  GIT_COMMITTER_NAME="$author_name" GIT_COMMITTER_EMAIL="$author_email" GIT_COMMITTER_DATE="$commit_date" \
    git -C "$1" commit -q -m "$2"
}

preflight() {
  set -e
  [ -z "$(git status --porcelain --untracked-files=no)" ]
  if [ -n "$expected_head" ]; then [ "$(git rev-parse HEAD)" = "$expected_head" ]; fi
  [ "$(node -v | cut -d. -f1)" = v22 ]
  printf '%s  %s\n' "$app_manifest_sha" "$app_manifest" | sha256sum --check
  [ "$(cat "$mux/mux.sha")" = "$mux_sha" ]
  printf '%s  %s\n' "$base_pin_sha" "$base_pin" | sha256sum --check
  for commit in "$ga_gate" "$gb_gate" "$base_subject" "${cap_commits[@]}"; do git cat-file -e "$commit^{commit}"; done
  git rev-parse HEAD > "$out/head.txt"
}

lock_scope1() {
  set -e
  corepack pnpm install --frozen-lockfile --prefer-offline
  corepack pnpm generate:runtime-assets-lock
  git add runtime-assets.lock.json
  deterministic_commit "$root" "chore: regenerate the runtime asset lock for the C++ review fixes and A'

Generated on agentrunner by scripts/c-cpp-lane-validation/validate.sh."
  git rev-parse HEAD | tee "$out/lock-scope1.sha"
  cp runtime-assets.lock.json "$out/evidence/runtime-assets.lock.scope1.json"
  git push -q origin "HEAD:refs/heads/job-c-cpp-validate-scope1"
}

lock_cap() {
  set -e
  git worktree add -q --detach "$out/cap" "$(cat "$out/lock-scope1.sha")"
  cd "$out/cap"
  GIT_COMMITTER_NAME="$author_name" GIT_COMMITTER_EMAIL="$author_email" GIT_COMMITTER_DATE="$commit_date" \
    git cherry-pick "${cap_commits[@]}"
  corepack pnpm install --frozen-lockfile --prefer-offline
  corepack pnpm generate:runtime-assets-lock
  git add runtime-assets.lock.json
  deterministic_commit "$out/cap" "chore: regenerate the runtime asset lock for the provisional judged-output cap

Generated on agentrunner by scripts/c-cpp-lane-validation/validate.sh."
  git rev-parse HEAD | tee "$out/lock-cap.sha"
  cp runtime-assets.lock.json "$out/evidence/runtime-assets.lock.cap.json"
  git push -q origin "HEAD:refs/heads/job-c-cpp-validate-cap"
}

tsx() { corepack pnpm exec tsx --tsconfig tsconfig.base.json "$@"; }

ga() {
  # ga NAME SUBJECT TARBALL SHA APP_MANIFEST_OR_EMPTY
  set -e
  local name=$1 subject=$2 tarball=$3 sha=$4 manifest=$5
  git worktree add -q --detach "$out/gate-$name" "$ga_gate"
  cd "$out/gate-$name"
  corepack pnpm install --frozen-lockfile --prefer-offline
  CI=1 TRACECODE_STAGE1_SUBJECT="$subject" TRACECODE_STAGE1_SUBJECT_TARBALL="$tarball" \
  TRACECODE_STAGE1_SUBJECT_SHA256="$sha" TRACECODE_STAGE1_RECEIPT_LANGUAGES=cpp \
    bash tests/stage1-gates/agent-runner.sh "$name" '^G[16]/cpp/' "$manifest" "$mux" || true
  cp -R "gate-evidence/$name" "$out/evidence/ga-$name"
  rm -rf "$out/evidence/ga-$name/app-traces"
  test -f "$out/evidence/ga-$name/summary.json"
}

gb() {
  # gb NAME SUBJECT TARBALL SHA
  set -e
  local name=$1 subject=$2 tarball=$3 sha=$4
  git worktree add -q --detach "$out/gb-$name" "$gb_gate"
  cd "$out/gb-$name"
  corepack pnpm install --frozen-lockfile --prefer-offline
  CI=1 TRACECODE_STAGE1_SUBJECT="$subject" TRACECODE_STAGE1_SUBJECT_TARBALL="$tarball" \
  TRACECODE_STAGE1_SUBJECT_SHA256="$sha" GB_LANGUAGES=cpp TRACECODE_STAGE1_MUX_INPUT="$mux" \
    bash tests/stage1-gates/gb-pack.sh "$name" || true
  cp -R "gate-evidence/$name" "$out/evidence/gb-$name"
  rm -rf "$out/evidence/gb-$name/site"
  ls "$out/evidence/gb-$name"/gb-*.json
}

pack() {
  set -e
  corepack pnpm materialize:csharp-role-assets
  corepack pnpm build
  mkdir -p "$out/pin"
  corepack pnpm pack --pack-destination "$out/pin"
  cd "$out/pin"
  local tgz
  tgz=$(ls *.tgz)
  mv "$tgz" "c-cpp-$(cut -c1-8 "$out/lock-scope1.sha").tgz"
  sha256sum c-cpp-*.tgz | tee pin.sha256
}

sample() {
  set -e
  local consumer="$out/sample-consumer"
  mkdir -p "$consumer"
  printf '%s\n' '{"name":"c-cpp-sample","private":true,"type":"module"}' > "$consumer/package.json"
  (cd "$consumer" && corepack pnpm --ignore-workspace add --prefer-offline --ignore-scripts "$out"/pin/c-cpp-*.tgz &&
    node node_modules/@tracecode/harness/dist/cli.cjs sync-assets "$out/sample-assets")
  node scripts/c-cpp-lane-validation/sample-run.mjs "$consumer" "$out/sample-assets" \
    "$out/evidence/cpp-macro-operation-refusal-sample.json" scripts/c-cpp-lane-validation/macro-fixture.json
}

register() {
  set -e
  cd "$out/pin"
  local name
  name=$(ls c-cpp-*.tgz)
  [ ! -e "$registry/$name" ]
  cp "$name" "$registry/$name"
  cp pin.sha256 "$registry/$name.sha256"
  chmod 0444 "$registry/$name" "$registry/$name.sha256"
  (cd "$registry" && sha256sum --check "$name.sha256")
}

step preflight preflight || { cat "$out/steps.txt"; exit 2; }
step lock-scope1 lock_scope1 || { cat "$out/steps.txt"; exit 3; }
step lock-cap lock_cap

# Scope-1 suites at the scope-1 lock commit.
step rewriter tsx tests/test-cpp-rewriter.ts
step typecheck-root corepack pnpm exec tsc -p tsconfig.root.json --noEmit
step value-type-browser tsx tests/test-cpp-value-type-arguments-browser.ts
step delete-alias-browser tsx tests/test-cpp-ops-class-delete-alias-browser.ts
step cpp-browser-worker corepack pnpm run test:cpp-browser-worker
step cpp-public-surface corepack pnpm run test:cpp-public-surface
step cpp-prepared-lifecycle corepack pnpm run test:cpp-prepared-lifecycle
# The provisional cap at its own lock commit.
if [ -f "$out/lock-cap.sha" ]; then
  step cap-judged-output-browser bash -c "cd '$out/cap' && corepack pnpm exec tsx --tsconfig tsconfig.base.json tests/test-cpp-judged-output-limit-browser.ts"
  step cap-rewriter bash -c "cd '$out/cap' && corepack pnpm exec tsx --tsconfig tsconfig.base.json tests/test-cpp-rewriter.ts"
fi

if step pack pack; then
  pin=$(ls "$out"/pin/c-cpp-*.tgz)
  pin_sha=$(cut -d' ' -f1 "$out/pin/pin.sha256")
  scope1=$(cat "$out/lock-scope1.sha")
  step a-prime-sample sample
  step ga-lane ga c-cpp-lane "$scope1" "$pin" "$pin_sha" "$app_manifest"
  step ga-step7 ga c-cpp-step7 "$base_subject" "$base_pin" "$base_pin_sha" ''
  step gb-lane gb c-cpp-lane "$scope1" "$pin" "$pin_sha"
  step gb-step7 gb c-cpp-step7 "$base_subject" "$base_pin" "$base_pin_sha"
  step register register
fi
step compare python3 scripts/c-cpp-lane-validation/compare.py "$out"

kill "$sampler" 2>/dev/null
awk '{split($2,l,"="); split($3,m,"="); if (l[2] > pl) pl = l[2]; if (m[2] > pm) pm = m[2]} END {printf "peak_load=%s peak_mem_used_mb=%s\n", pl, pm}' \
  "$out/resources.txt" | tee -a "$out/steps.txt"
cat "$out/steps.txt"
exit "$failed"
