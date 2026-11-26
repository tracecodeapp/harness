#!/usr/bin/env bash
set -euo pipefail
source_dir="$(cd "$(dirname "$0")" && pwd)"
stage=/root/ci/g8-candidates.qHpuBwkE

test -r "$stage/final-release/runner-dependencies.json"
test -d "$stage/node_modules" -a ! -L "$stage/node_modules"

files=(
  runner.sha256
  final-release-preflight-plan.mjs
  final-release-session.test.mjs
  preflight-final-release.sh
  run-final-release-preflight-job.sh
  session-final-release.sh
  stage-final-release-dependencies.sh
  dry-run-final-release.sh
  java-runner/candidate-witness-policy.mjs
  java-runner/candidate-witness-policy.test.mjs
  java-runner/csharp-candidate-witness.mjs
  java-runner/csharp-candidate-witness.test.mjs
  java-runner/csharp-replenishment-witness.mjs
  java-runner/entry.ts
  java-runner/java-candidate-witness.mjs
  java-runner/java-candidate-witness.test.mjs
  java-runner/run-g8.mjs
)

echo "preflight_source=$source_dir preflight_stage=$stage"
for relative in "${files[@]}"; do
  install -D -m 0644 "$source_dir/$relative" "$stage/$relative"
done
chmod 0755 \
  "$stage/preflight-final-release.sh" \
  "$stage/session-final-release.sh" \
  "$stage/stage-final-release-dependencies.sh" \
  "$stage/dry-run-final-release.sh"

(cd "$stage" && sha256sum --strict -c runner.sha256)
SPEED_G8_PREFLIGHT_ORDINARY=1 bash "$stage/preflight-final-release.sh" 35
