#!/usr/bin/env bash
set -euo pipefail
result_dir=$1
mkdir -p "$result_dir" .cache
previous=92eb4c5d7aff4b41f6ced4b36b26405e1548d4bf
scratch=$(mktemp -d .cache/stage1-csharp-XXXXXX)
trap 'rm -rf "$scratch"' EXIT

run() {
  corepack pnpm exec tsx --tsconfig tsconfig.base.json tests/test-csharp-stale-trace-deadline-browser.ts
}

if ! run >"$result_dir/csharp-good.log" 2>&1; then
  tail -30 "$result_dir/csharp-good.log"
  exit 1
fi
if ! git cat-file -e "$previous^{commit}"; then
  git fetch --no-tags origin "$previous"
fi
git archive "$previous" workers/vendor/csharp-role-artifacts | tar x -C "$scratch"
corepack pnpm exec tsx --tsconfig tsconfig.base.json scripts/csharp-role-artifacts.ts materialize "$scratch"
if TRACECODE_CSHARP_TEST_RUNNER_ASSET_PATH="$scratch/workers/vendor/csharp-runner" \
    run >"$result_dir/csharp-stale-runner.log" 2>&1; then
  echo 'G2/csharp/post-pause/control: stale runner passed'
  exit 1
fi
grep -E 'G2/csharp/post-pause/warm-1:.*client-timeout' "$result_dir/csharp-stale-runner.log"
echo "G2/csharp/post-pause/warm-1: historical runner $previous hit=1"
run >"$result_dir/csharp-repaired.log" 2>&1
