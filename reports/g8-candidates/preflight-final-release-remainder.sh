#!/usr/bin/env bash
set -euo pipefail
max_minutes="${1:-25}"
[[ "$max_minutes" =~ ^[1-9][0-9]*$ && "${SPEED_G8_PREFLIGHT_ORDINARY:-}" == 1 ]] || exit 2
stage="$(cd "$(dirname "$0")" && pwd)"
original="$stage/final-release"
test -r "$original/manifest.json" -a -r "$original/runner-dependencies.json"
test -d "$stage/node_modules" -a ! -L "$stage/node_modules"
(cd "$stage" && sha256sum --strict -c runner.sha256)
runner_commit="$(node -e 'const r=require(process.argv[1]); process.stdout.write(r.runnerCommit)' \
  "$original/runner-dependencies.json")"
[[ "$runner_commit" =~ ^[0-9a-f]{40}$ ]]
export SPEED_G8_RUNNER_COMMIT="$runner_commit"
cd "$stage"
node --test phone-warm-aa.test.mjs score-final-release-merged.test.mjs \
  final-release-session.test.mjs java-runner/csharp-production-control-witness.test.mjs
node audit-csharp-lesson-saved-rows.mjs \
  "$original/final-csharp-desktop-samples.jsonl"
node --input-type=module -e \
  'await import("esbuild"); await import("playwright"); console.log("runner imports: OK")'

run="$stage/final-release-remainder-preflight-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir "$run"
out="$run/output"
mkdir "$out"
for name in vcandidate vfinal-main v0.17.1 v0.20.1; do ln -s "$original/$name" "$out/$name"; done
cp "$original/manifest.json" "$out/manifest.json"
node "$stage/final-release-remainder-preflight-plan.mjs" \
  "$original/shape-inventory.json" "$run"
deadline=$((SECONDS + max_minutes * 60))

minutes_left() {
  local left=$((deadline - SECONDS))
  ((left > 0)) || return 124
  printf '%d.%02d' "$((left / 60))" "$((left % 60 * 100 / 60))"
}

run_phone_aa() {
  local left
  left="$(minutes_left)"
  env SPEED_G8_PHONE_WARM_AA=1 SPEED_G8_OUTPUT_TAG=preflight \
    SPEED_G8_SHAPE_PROBE_FILE="$run/phone-warm-aa.json" \
    node "$stage/java-runner/run-g8.mjs" "$out" run phone 212026 "$left" \
      > "$run/phone-warm-aa.log" 2>&1
  node "$stage/score-phone-warm-aa.mjs" "$out" preflight-phone-warm-aa --preflight \
    > "$run/phone-warm-aa-score.log"
}

run_remainder() {
  local language="$1" scope="$2" window=phone left
  [[ "$scope" == desktop ]] && window=desktop-a
  left="$(minutes_left)"
  env SPEED_G8_FINAL_RELEASE=1 SPEED_G8_FINAL_REMAINDER=1 SPEED_G8_LIVE_CONTROL=1 \
    SPEED_G8_OUTPUT_TAG=preflight SPEED_G8_LANGUAGE="$language" SPEED_JAVA_SCOPE="$scope" \
    SPEED_G8_SHAPE_PROBE_FILE="$run/$language-$scope.json" \
    node "$stage/java-runner/run-g8.mjs" "$out" run "$window" 212026 "$left" \
      > "$run/$language-$scope.log" 2>&1
}

run_phone_aa
run_remainder csharp desktop
for language in java cpp typescript javascript; do
  run_remainder "$language" phone
  run_remainder "$language" desktop
done

node --input-type=module - "$run" "$out" <<'JS'
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
const [root, out] = process.argv.slice(2);
const metadataFiles = readdirSync(out).filter((name) => name.endsWith('-metadata.json'));
assert.equal(metadataFiles.length, 10);
let kept = 0;
let invalid = 0;
for (const file of metadataFiles) {
  const metadata = JSON.parse(readFileSync(join(out, file), 'utf8'));
  assert.equal(metadata.complete, true, file);
  const samples = file.replace('-metadata.json', '-samples.jsonl');
  for (const line of readFileSync(join(out, samples), 'utf8').trim().split('\n')) {
    const row = JSON.parse(line);
    kept += Number(Boolean(row.kept));
    invalid += Number(Boolean(row.invalid || row.refusal));
  }
}
assert.equal(kept, 154);
assert.equal(invalid, 0);
const lesson = JSON.parse(readFileSync(join(out,
  'preflight-final-csharp-desktop-metadata.json'), 'utf8'));
assert.equal(lesson.schedule.length, 1);
assert.equal(lesson.schedule[0].journey, 'lesson');
const lessonRows = readFileSync(join(out,
  'preflight-final-csharp-desktop-samples.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
assert.deepEqual(Object.fromEntries(lessonRows.map(({ version, kept, invalid }) =>
  [version, { kept: Number(Boolean(kept)), invalid: Number(Boolean(invalid)) }])), {
  '0.17.1': { kept: 1, invalid: 0 },
  'candidate-main': { kept: 1, invalid: 0 },
});
console.log(JSON.stringify({ sessions: metadataFiles.length, kept, invalid,
  csharpLesson: '1/1 kept, 0/0 invalid', runDirectory: root }));
JS
echo "Final release remainder ordinary preflight passed: $run"
