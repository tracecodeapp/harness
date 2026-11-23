#!/usr/bin/env bash
# Bounded qualification run. The full suite belongs on GitHub Actions.
set -eu
ulimit -c 0
job=$PWD
mkdir -p "$job/stage1-receipts"
proof=$(mktemp -d)
baseline="$proof/baseline"
trap 'if [ -d "$baseline" ]; then git worktree remove --force "$baseline"; fi; rm -rf "$proof"' EXIT
candidate=$(git rev-parse HEAD)
frozen=b025fdb8220694cdfe96b136a0b8bb82843f7371
if ! git cat-file -e "$frozen^{commit}"; then
  git fetch --no-tags https://github.com/tracecodeapp/harness.git refs/heads/release/0.20.4
fi
# ar-harness selects the latest Node 22. The pack gate requires the exact release pin.
set +u
source ~/.nvm/nvm.sh
nvm use 22.18.0
set -u
record() {
  local label=$1 start=$SECONDS
  shift
  local status=0
  "$@" >"$job/stage1-receipts/$label.log" 2>&1 || status=$?
  echo "$label exit=$status elapsed=$((SECONDS - start))s"
  tail -8 "$job/stage1-receipts/$label.log"
  return "$status"
}
pack() {
  local name=$1 sha=$2 status=0
  node scripts/stage1/clean-pack.mjs "$sha" "$proof/$name" || status=$?
  if [ -d "$proof/$name" ]; then mv "$proof/$name" "$job/stage1-receipts/$name"; fi
  return "$status"
}
exit_status=0
if record baseline-pack pack b025-pack "$frozen"; then
  echo "G7/control: b025fdb8 unexpectedly passed"
  exit_status=1
elif ! grep -F 'G7/build/tree-dirty' "$job/stage1-receipts/baseline-pack.log" ||
     ! grep -F 'workers/javascript/javascript-project-worker.js' "$job/stage1-receipts/b025-pack/build.status"; then
  echo "G7/control: b025fdb8 failed before the expected assertion"
  exit_status=1
fi
if record candidate-pack pack candidate-pack "$candidate"; then
  if ! record digest-control bash scripts/stage1/prove-digest.sh "$job/stage1-receipts/candidate-pack"; then exit_status=1; fi
else
  exit_status=1
fi
git worktree add --detach "$baseline" "$frozen"
cp scripts/check-untraced-host-history.mjs scripts/untraced-host-history.browser.ts "$baseline/scripts/"
(
  cd "$baseline"
  corepack pnpm install --frozen-lockfile --prefer-offline >"$job/stage1-receipts/baseline-install.log" 2>&1
  export TRACECODE_HOST_HISTORY_REPORT="$job/stage1-receipts/W-typescript-b025.json"
  if record W-typescript-b025 corepack pnpm exec tsx --tsconfig tsconfig.base.json scripts/check-untraced-host-history.mjs typescript; then
    echo "G2/control: b025fdb8 unexpectedly passed"
    exit 1
  fi
  node "$job/scripts/stage1/verify-host-history-baseline.mjs" "$TRACECODE_HOST_HISTORY_REPORT"
) || exit_status=1
exit "$exit_status"
