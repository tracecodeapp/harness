#!/usr/bin/env bash
set -euo pipefail
stage="$(cd "$(dirname "$0")" && pwd)"
tmp="$(mktemp -d /tmp/g8-final-design.XXXXXX)"
cleanup() {
  case "$tmp" in /tmp/g8-final-design.*) rm -rf -- "$tmp" ;; *) exit 2 ;; esac
}
trap cleanup EXIT

node --test \
  "$stage/final-release-plan.test.mjs" \
  "$stage/final-release-inventory.test.mjs" \
  "$stage/python-experiment-plan.test.mjs" \
  "$stage/java-runner/version-preparation.test.mjs"
node "$stage/final-release-inventory.mjs" "$tmp/shape-inventory.json"

for language in javascript typescript cpp java csharp; do
  for scope in phone desktop; do
    window=phone
    [[ "$scope" == desktop ]] && window=desktop-a
    SPEED_G8_FINAL_RELEASE=1 SPEED_G8_LIVE_CONTROL=1 SPEED_G8_LANGUAGE="$language" \
      SPEED_JAVA_SCOPE="$scope" SPEED_G8_INVENTORY_ONLY=1 \
      node "$stage/java-runner/run-g8.mjs" "$tmp" run "$window" 212026 1 \
      > "$tmp/$language-$scope.json"
  done
done

node --input-type=module - "$tmp" <<'JS'
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const root = process.argv[2];
let groups = 0;
let versionAttempts = 0;
for (const language of ['javascript', 'typescript', 'cpp', 'java', 'csharp']) {
  for (const scope of ['phone', 'desktop']) {
    const receipt = JSON.parse(readFileSync(`${root}/${language}-${scope}.json`));
    const distinct = new Set(receipt.shapes.map(({ group }) => JSON.stringify(group)));
    groups += distinct.size;
    versionAttempts += receipt.shapes.reduce((total, { group }) => total + group.target, 0);
  }
}
assert.equal(groups, 91);
assert.equal(versionAttempts, 3640);
console.log(JSON.stringify({ nonPythonGroups: groups, nonPythonVersionAttempts: versionAttempts,
  pythonGroups: 12, pythonVersionAttempts: 480, pythonCaptureAttempts: 24,
  totalGroups: 103, totalMeasuredAttempts: 4120 }));
JS
