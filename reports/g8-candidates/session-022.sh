#!/usr/bin/env bash
set -euo pipefail
source_dir="$(cd "$(dirname "$0")" && pwd)"
checkout="$(git -C "$source_dir" rev-parse --show-toplevel)"
rig_commit="$(git -C "$checkout" rev-parse HEAD)"
test -z "$(git -C "$checkout" status --porcelain --untracked-files=all)"

operation="${1:?Expected selftest or window}"
out="${2:?Expected a new absolute output directory}"
production="${3:?Expected the absolute path to the published 0.21.0 tarball}"
[[ "$out" == /* && "$production" == /* ]]
[[ "$(realpath -m "$out")" != "$checkout" && "$(realpath -m "$out")" != "$checkout/"* ]]
read -r production_sha _ < <(sha256sum "$production")
expected_production=935c61d9f3f961056216a88922af31fa03279b58beefe2a8ff5d829563b9da62
[[ "$production_sha" == "$expected_production" ]] || { echo 'Published 0.21.0 tarball digest differs' >&2; exit 2; }

case "$operation" in
  selftest)
    [[ "$#" == 3 && "${SPEED_EXCLUSIVE_WINDOW:-}" != 1 ]]
    minutes=40
    ;;
  window)
    receipt="${4:?Expected the self-test pass receipt}"
    candidate="${5:?Expected the absolute path to the candidate tarball}"
    candidate_sha="${6:?Expected the candidate SHA-256}"
    reference="${7:?Expected the registered control reference JSON}"
    minutes="${8:?Expected a window budget in minutes}"
    [[ "$candidate" == /* && "$reference" == /* && "$minutes" =~ ^[1-9][0-9]*$ ]]
    node "$source_dir/selftest-receipt-022.mjs" require "$receipt" "$rig_commit" "$production_sha"
    read -r actual_candidate_sha _ < <(sha256sum "$candidate")
    [[ "$actual_candidate_sha" == "$candidate_sha" && -r "$reference" ]]
    ;;
  *)
    echo "Unknown operation: $operation" >&2
    exit 2
    ;;
esac

mkdir "$out"
stage="$out/stage"
cp -a "$source_dir" "$stage"
cp -a "$checkout/benchmarks/speed-baseline-021" "$stage/baseline"
cp -a "$stage/baseline/dependency-locks" "$stage/java-runner/dependency-locks"
cp "$stage/baseline/fixture-digests.json" "$stage/java-runner/fixture-digests.json"

runner_deps="${SPEED_G8_RUNNER_DEPS:-/root/ci/g8-candidates.qHpuBwkE/node_modules}"
mkdir -p "$stage/node_modules/@esbuild"
cp -aL "$runner_deps/esbuild" "$runner_deps/playwright" "$runner_deps/playwright-core" "$stage/node_modules/"
cp -aL "$runner_deps/@esbuild/linux-x64" "$stage/node_modules/@esbuild/"

export SPEED_G8_RUNNER_COMMIT="$rig_commit"
cd "$stage"
node --input-type=module -e 'await import("esbuild"); await import("playwright")'

if [[ "$operation" == selftest ]]; then
  node --test "$stage/score-thresholds.test.mjs"
  node "$stage/selftest-scorers-022.mjs" "$out" "$rig_commit" "$source_dir/session-022.sh" "$production"
fi

node "$stage/stage.mjs" "$production" "$production_sha" none "$out/vproduction"
if [[ "$operation" == selftest ]]; then
  SPEED_RIG_022_OPERATION=selftest node "$stage/java-runner/run-g8.mjs" "$out" smoke desktop-a 212026 "$minutes"
  node "$stage/selftest-receipt-022.mjs" record "$out/selftest-pass.json" "$rig_commit" "$production_sha"
  node "$stage/selftest-receipt-022.mjs" require "$out/selftest-pass.json" "$rig_commit" "$production_sha"
else
  node "$stage/stage.mjs" "$candidate" "$candidate_sha" none "$out/vcandidate"
  # Verify again immediately before requesting the exclusive slots.
  node "$stage/selftest-receipt-022.mjs" require "$receipt" "$rig_commit" "$production_sha"
  status=0
  window_env=(
    SPEED_EXCLUSIVE_WINDOW=1
    SPEED_RIG_022_OPERATION=window
    SPEED_RIG_022_CANDIDATE_SHA256="$candidate_sha"
    SPEED_RIG_022_GROUPS="${9:--}"
  )
  /root/ci/bin/heavy-exclusive env "${window_env[@]}" node "$stage/java-runner/run-g8.mjs" "$out" run desktop-a 212026 "$minutes" || status=$?
  if ((status != 0)); then exit "$status"; fi
  node "$stage/score-022.mjs" "$reference" "$out"
fi
