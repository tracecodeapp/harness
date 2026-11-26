#!/usr/bin/env bash
set -euo pipefail
max_minutes="${1:-35}"
[[ "$max_minutes" =~ ^[1-9][0-9]*$ && "${SPEED_G8_PREFLIGHT_ORDINARY:-}" == 1 ]] || exit 2
stage="$(cd "$(dirname "$0")" && pwd)"
out="$stage/final-release"
test -r "$out/manifest.json" -a -r "$out/runner-dependencies.json"
test -d "$stage/node_modules" -a ! -L "$stage/node_modules"
(cd "$stage" && sha256sum --strict -c runner.sha256)
runner_commit="$(node -e 'const r=require(process.argv[1]); process.stdout.write(r.runnerCommit)' \
  "$out/runner-dependencies.json")"
[[ "$runner_commit" =~ ^[0-9a-f]{40}$ ]]
export SPEED_G8_RUNNER_COMMIT="$runner_commit"
cd "$stage"
node --input-type=module -e \
  'await import("esbuild"); await import("playwright"); console.log("all external runner imports: OK")'

run="$out/preflight-$(date -u +%Y%m%dT%H%M%SZ)"
node "$stage/final-release-preflight-plan.mjs" "$out/shape-inventory.json" "$run"
deadline=$((SECONDS + max_minutes * 60))

make_out() {
  local dir="$1"
  mkdir "$dir"
  ln -s "$out/vcandidate" "$dir/vcandidate"
  ln -s "$out/vfinal-main" "$dir/vfinal-main"
  ln -s "$out/v0.17.1" "$dir/v0.17.1"
  ln -s "$out/v0.20.1" "$dir/v0.20.1"
  cp "$out/manifest.json" "$dir/manifest.json"
}

minutes_left() {
  local left=$((deadline - SECONDS))
  ((left > 0)) || return 124
  printf '%d.%02d' "$((left / 60))" "$((left % 60 * 100 / 60))"
}

run_python() {
  local scope="$1" dir window=phone left
  dir="$run/python-$scope"
  [[ "$scope" == desktop ]] && window=desktop-b
  make_out "$dir"
  left="$(minutes_left)"
  env SPEED_EXCLUSIVE_WINDOW=1 SPEED_G8_EXPERIMENT="final-$scope" \
    SPEED_G8_CAPTURE_ONLY=1 SPEED_G8_FORCE_UNCAPTURED=1 \
    node "$stage/python-runner/run-g8.mjs" "$stage/baseline" "$dir" "$window" \
      "$dir/manifest.json" 212026 "$left" > "$run/python-$scope.log" 2>&1
}

run_language() {
  local language="$1" scope="$2" dir window=phone left
  dir="$run/$language-$scope"
  [[ "$scope" == desktop ]] && window=desktop-a
  make_out "$dir"
  left="$(minutes_left)"
  env SPEED_EXCLUSIVE_WINDOW=1 SPEED_G8_FINAL_RELEASE=1 SPEED_G8_LIVE_CONTROL=1 \
    SPEED_G8_LANGUAGE="$language" SPEED_JAVA_SCOPE="$scope" \
    SPEED_G8_SHAPE_PROBE_FILE="$run/$language-$scope.json" \
    node "$stage/java-runner/run-g8.mjs" "$dir" run "$window" 212026 "$left" \
      > "$run/$language-$scope.log" 2>&1
}

for language in java csharp; do
  run_language "$language" phone
  run_language "$language" desktop
done
run_python phone
run_python desktop
for language in javascript typescript cpp; do
  run_language "$language" phone
  run_language "$language" desktop
done

node --input-type=module - "$run" <<'JS'
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
const root = process.argv[2];
const logs = readdirSync(root).filter((name) => name.endsWith('.log'));
assert.equal(logs.length, 12);
for (const log of logs) {
  const text = readFileSync(join(root, log), 'utf8');
  assert.doesNotMatch(text, /ERR_MODULE_NOT_FOUND|ENOENT|Uncaptured shape rejected/u, log);
}
const sessions = readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory());
assert.equal(sessions.length, 12);
let kept = 0;
for (const session of sessions) {
  const dir = join(root, session.name);
  const metadata = readdirSync(dir).filter((name) => name.endsWith('-metadata.json'));
  assert.equal(metadata.length, 1, session.name);
  const report = JSON.parse(readFileSync(join(dir, metadata[0]), 'utf8'));
  assert.equal(report.complete, true, session.name);
  const samples = readdirSync(dir).filter((name) => name.endsWith('-samples.jsonl'));
  assert.equal(samples.length, 1, session.name);
  for (const line of readFileSync(join(dir, samples[0]), 'utf8').trim().split('\n')) {
    const sample = JSON.parse(line);
    if (sample.kept) kept++;
  }
}
assert.equal(kept, 206);
console.log(JSON.stringify({ sessions: sessions.length, kept, invalid: 0, runDirectory: root }));
JS
echo "Final release ordinary preflight passed: $run"
