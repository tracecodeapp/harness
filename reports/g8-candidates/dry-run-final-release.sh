#!/usr/bin/env bash
set -euo pipefail
stage="$(cd "$(dirname "$0")" && pwd)"
out="$stage/final-release"
test -r "$out/manifest.json"

node --test \
  "$stage/final-release-plan.test.mjs" \
  "$stage/final-release-inventory.test.mjs" \
  "$stage/final-release-session.test.mjs" \
  "$stage/java-runner/candidate-witness-policy.test.mjs" \
  "$stage/java-runner/csharp-candidate-witness.test.mjs" \
  "$stage/java-runner/java-candidate-witness.test.mjs" \
  "$stage/python-experiment-plan.test.mjs" \
  "$stage/java-runner/version-preparation.test.mjs"
bash "$stage/session-process-group.test.sh"
node "$stage/final-release-inventory.mjs" "$out/shape-inventory.json"

for name in final-phone final-desktop; do
  window=phone
  [[ "$name" == final-desktop ]] && window=desktop-b
  SPEED_G8_EXPERIMENT="$name" node "$stage/python-runner/run-g8.mjs" \
    "$stage/baseline" "$out" "$window" "$out/manifest.json" 212026 1 --check
done
for language in javascript typescript cpp java csharp; do
  for scope in phone desktop; do
    window=phone
    [[ "$scope" == desktop ]] && window=desktop-a
    SPEED_G8_FINAL_RELEASE=1 SPEED_G8_LIVE_CONTROL=1 SPEED_G8_LANGUAGE="$language" \
      SPEED_JAVA_SCOPE="$scope" SPEED_G8_INVENTORY_ONLY=1 \
      node "$stage/java-runner/run-g8.mjs" "$out" run "$window" 212026 1 \
      > "$out/inventory-$language-$scope.json"
  done
done

echo 'Final release design dry-run passed without timed samples.'
