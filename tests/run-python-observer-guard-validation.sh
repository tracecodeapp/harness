#!/usr/bin/env bash
# One-job validation for the Python observer-scope change (D1), for a host
# that can build (Linux, Node 22, pnpm 10.4.1, Playwright Chromium 1208).
#
#   bash tests/run-python-observer-guard-validation.sh <out-dir>
#
# Run it in a disposable, clean checkout of the commit under test; it
# installs, builds and packs in place. Every step runs (a failure does not
# skip the next), and <out-dir>/summary.tsv records each step's exit status,
# wall seconds, peak RSS and CPU. The script exits non-zero if any step failed.
#
# 1. lock: `pnpm build` regenerates runtime-assets.lock.json; the new lock may
#    change only the Python component's python-runtime.js entry and the
#    aggregates that sum over it. Every other component is compared byte for
#    byte with a lock rendered before the build. The built lock is copied to
#    <out-dir> for evidence.
# 2. browser-worker: pnpm test:python-browser-worker.
# 3. installed: tests/run-python-ordinary-installed.sh (packs the built tree,
#    serves the unpacked package to Chromium).
# 4. retained-observer-browser: the D1 browser test, through the host's
#    observation reply path that F1 (#89) changed.
set -uo pipefail

out=${1:?usage: run-python-observer-guard-validation.sh <out-dir>}
mkdir -p "$out"
out=$(cd "$out" && pwd)
summary="$out/summary.tsv"
printf 'step\texit\twall_s\tmax_rss_mb\tcpu_percent\n' > "$summary"
failed=0

{
  echo "head $(git rev-parse HEAD)"
  echo "node $(node -v) pnpm $(pnpm -v)"
  echo "started $(date -u +%FT%TZ)"
} | tee "$out/environment.txt"
if [[ -n $(git status --porcelain) ]]; then
  echo 'The checkout is not clean.' >&2
  exit 2
fi
[[ $(node -v) == v22.* ]] || { echo 'Node 22 is required.' >&2; exit 2; }

run_step() {
  local name=$1
  shift
  local log="$out/$name.log" timing="$out/$name.time" started status
  started=$(date +%s)
  echo "== $name: $*"
  if declare -F "$1" > /dev/null; then
    "$@" > "$log" 2>&1
  elif [[ -x /usr/bin/time ]]; then
    /usr/bin/time -v -o "$timing" "$@" > "$log" 2>&1
  else
    "$@" > "$log" 2>&1
  fi
  status=$?
  local rss=- cpu=-
  if [[ -f $timing ]]; then
    rss=$(awk -F': ' '/Maximum resident set size/ {printf "%d", $2 / 1024}' "$timing")
    cpu=$(awk -F': ' '/Percent of CPU/ {gsub("%", "", $2); print $2}' "$timing")
  fi
  printf '%s\t%s\t%s\t%s\t%s\n' "$name" "$status" "$(( $(date +%s) - started ))" "$rss" "$cpu" >> "$summary"
  echo "   exit $status"
  tail -5 "$log"
  (( status == 0 )) || failed=1
}

render_baseline_lock() {
  node --import tsx scripts/generate-runtime-assets-lock.mjs --stdout > "$out/base-lock.json"
}

check_lock() {
  git status --porcelain > "$out/status-after-build.txt"
  if [[ -s "$out/status-after-build.txt" ]]; then
    cat "$out/status-after-build.txt"
    echo 'The build changed the worktree.'
    return 1
  fi
  node - "$out/base-lock.json" runtime-assets.lock.json <<'EOF'
const { readFileSync } = require('node:fs');
const [base, next] = process.argv.slice(2).map((path) => JSON.parse(readFileSync(path, 'utf8')));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const problems = [];
const CHANGED = 'workers/python/python-runtime.js';
for (const key of new Set([...Object.keys(base), ...Object.keys(next)])) {
  if (['harness', 'packageTreeSha256', 'totalPackagedRuntimeBytes', 'components', 'stagedInventory'].includes(key)) continue;
  if (!same(base[key], next[key])) problems.push(key);
}
const names = new Set([...Object.keys(base.components), ...Object.keys(next.components)]);
for (const name of names) {
  if (name !== 'python' && !same(base.components[name], next.components[name])) problems.push(`components.${name}`);
}
const before = base.components.python.files;
const after = next.components.python.files;
const changed = after.filter((file, index) => !same(file, before[index]));
if (before.length !== after.length || !same(before.map((f) => f.path), after.map((f) => f.path))) {
  problems.push('components.python file list');
} else if (changed.length > 1 || (changed.length === 1 && changed[0].path !== CHANGED)) {
  problems.push(`components.python files: ${changed.map((f) => f.path).join(', ')}`);
}
const delta = (after.find((f) => f.path === CHANGED)?.size ?? 0) - (before.find((f) => f.path === CHANGED)?.size ?? 0);
if (next.components.python.totalBytes - base.components.python.totalBytes !== delta) problems.push('components.python.totalBytes');
if (next.totalPackagedRuntimeBytes - base.totalPackagedRuntimeBytes !== delta) problems.push('totalPackagedRuntimeBytes');
if (next.harness.name !== base.harness.name || next.harness.version !== base.harness.version) problems.push('harness');
// The staged inventory lists the same files; only Python byte counts move.
const withoutBytes = (value) => JSON.parse(JSON.stringify(value, (key, item) => (key === 'bytes' ? undefined : item)));
if (!same(withoutBytes(base.stagedInventory), withoutBytes(next.stagedInventory))) problems.push('stagedInventory');
if (next.stagedInventory.bytes - base.stagedInventory.bytes !== delta) problems.push('stagedInventory.bytes');
for (const group of next.stagedInventory.groups ?? []) {
  const old = (base.stagedInventory.groups ?? []).find((entry) => entry.path === group.path);
  if (old && old.bytes !== group.bytes && !group.path.startsWith('python')) problems.push(`stagedInventory group ${group.path}`);
}
console.log(JSON.stringify({ changedFiles: changed.map((f) => f.path), sizeDelta: delta, problems }));
process.exit(problems.length === 0 ? 0 : 1);
EOF
  local status=$?
  cp runtime-assets.lock.json "$out/runtime-assets.lock.json"
  sha256sum runtime-assets.lock.json > "$out/runtime-assets.lock.json.sha256"
  return $status
}

run_step install pnpm install --frozen-lockfile
run_step baseline-lock render_baseline_lock
run_step build pnpm build
run_step lock check_lock
run_step lock-tests pnpm test:runtime-assets-lock
run_step browser-worker pnpm test:python-browser-worker
run_step installed bash tests/run-python-ordinary-installed.sh
run_step retained-observer-browser pnpm exec tsx --tsconfig tsconfig.base.json tests/test-python-retained-observer-browser.ts

echo "finished $(date -u +%FT%TZ)" >> "$out/environment.txt"
column -t -s $'\t' "$summary" 2>/dev/null || cat "$summary"
exit "$failed"
