#!/usr/bin/env bash
# Bounded G7 smoke under the shared host limiter. Full W and the catalog run separately.
set -euo pipefail
ulimit -c 0
if [ "$(node -v)" != v22.18.0 ]; then
  echo "G7/preflight: use pinned Node 22.18.0"
  exit 1
fi
job=$PWD
receipts="$job/stage1-receipts"
mkdir "$receipts"
proof=$(mktemp -d)
baseline="$proof/baseline"
trap 'if [ -d "$baseline" ]; then git worktree remove --force "$baseline"; fi; rm -rf "$proof"' EXIT
head=$(git rev-parse HEAD)
printf '%s\n' "$head" >"$receipts/runner.sha"
frozen=b025fdb8220694cdfe96b136a0b8bb82843f7371
tarball=/root/ci/coord-artifacts/tracecode-harness-0.20.4-b025fdb8-prelim.tgz
digest=7669429b3c0937853eb06e3afb5c51f4f9715be86d7564e4fca4e925832f5460
git cat-file -e "$frozen^{commit}"
node scripts/stage1/clean-pack.mjs --verify "$tarball" "$digest"
printf '%s  %s\n' "$digest" "$tarball" >"$receipts/canonical.sha256"
unexpected=()
record() {
  local label=$1 start=$SECONDS status=0
  shift
  "$@" >"$receipts/$label.log" 2>&1 || status=$?
  printf '%s\texit=%s\telapsed=%ss\n' "$label" "$status" "$((SECONDS - start))" | tee -a "$receipts/checks.tsv"
  tail -8 "$receipts/$label.log"
  return "$status"
}
check() {
  local label=$1
  if ! record "$@"; then unexpected+=("$label"); fi
}
source_pack() {
  local name=$1
  shift
  local status=0
  node scripts/stage1/clean-pack.mjs "$@" "$proof/$name" || status=$?
  if [ -d "$proof/$name" ]; then mv "$proof/$name" "$receipts/$name"; fi
  return "$status"
}
if record frozen-source-build source_pack frozen-source --source-only "$frozen" ||
   ! grep -Fx 'G7/build/tree-dirty' "$receipts/frozen-source-build.log" ||
   ! grep -Fx ' M workers/javascript/javascript-project-worker.js' "$receipts/frozen-source/build.status"; then
  unexpected+=(frozen-source-build)
fi

git worktree add --detach "$baseline" "$frozen"
(
  cd "$baseline"
  corepack pnpm install --frozen-lockfile --prefer-offline
) >"$receipts/frozen-companion-install.log" 2>&1
frozen_install() (
  cd "$baseline"
  node "$job/scripts/stage1/clean-pack.mjs" --existing "$frozen" "$tarball" "$digest" "$receipts/frozen-pack" "$proof"
)
if record frozen-install frozen_install; then
  installed="$proof/consumer/node_modules/@tracecode/harness"
  check frozen-packed-leaves env TRACECODE_G7_INSTALLED_PACKAGE="$installed" \
    node scripts/stage1/prove-known-leaves.mjs frozen-pack "$job" "$receipts"
  check frozen-digest-recheck node scripts/stage1/clean-pack.mjs --verify "$tarball" "$digest"
else
  unexpected+=(frozen-install)
fi

# Historical source-test evidence is separate from the repaired packed probes.
python3 - "$baseline" <<'PY'
from pathlib import Path
import sys

test = Path(sys.argv[1]) / "tests/test-tracekernel-hardening.ts"
source = test.read_text()
opening = "async function main(): Promise<void> {"
assert source.count(opening) == 1
test.write_text(source.replace(opening, opening + """
  if (process.argv.includes('--destructured-iterable')) {
    await testJavaScriptDestructuredIterableTracingDoesNotExhaustValues();
    return;
  }
"""))
PY
check historical-source-leaves node scripts/stage1/prove-known-leaves.mjs baseline "$baseline" "$receipts"

stale_worker_control() {
  local status=0
  bash scripts/stage1/prove-stale-worker.sh "$receipts/lane-pack" "$proof/stale-worker" || status=$?
  if [ -d "$proof/stale-worker" ]; then mv "$proof/stale-worker" "$receipts/stale-worker"; fi
  if [ -f "$proof/stale-worker.log" ]; then mv "$proof/stale-worker.log" "$receipts/stale-worker.log"; fi
  return "$status"
}
if record lane-clean-pack source_pack lane-pack "$head"; then
  check member-diff python3 scripts/stage1/tar-manifest.py "$tarball" "$receipts/pack-member-diff.json" \
    --against "$receipts"/lane-pack/*.tgz
  check digest-control bash scripts/stage1/prove-digest.sh "$receipts/lane-pack"
  check stale-worker-control stale_worker_control
else
  unexpected+=(lane-clean-pack)
fi

test ! -d packages/tracekernel/dist
check lane-source-leaves node scripts/stage1/prove-known-leaves.mjs candidate "$job" "$receipts"
browser_control=0
record browser-short-control node scripts/stage1/prove-known-leaves.mjs browser-control "$job" "$receipts" || browser_control=$?
if [ "$browser_control" != 1 ] || ! grep -F 'short-circuit hit=1' "$receipts/browser-short-control.log"; then
  unexpected+=(browser-short-control)
fi
check python-argv corepack pnpm exec tsx --tsconfig tsconfig.base.json tests/test-python-script-file.ts
check recorder-control bash scripts/stage1/prove-recorder.sh
check ledger-controls node --test tests/test-stage1-suite-floor.mjs
check release-diff-controls env PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -v -s scripts/release-diff -p test_qualify.py
python3 - "$receipts/verdict.json" "${unexpected[@]}" <<'PY'
import json
from pathlib import Path
import sys

path, *unexpected = sys.argv[1:]
Path(path).write_text(json.dumps({"unexpected": unexpected}, indent=2) + "\n")
print(f"G7/smoke unexpected={unexpected}")
PY
test "${#unexpected[@]}" = 0
