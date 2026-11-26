#!/usr/bin/env bash
set -uo pipefail
max_minutes="${1:?Expected total window minutes}"
[[ "$max_minutes" =~ ^[1-9][0-9]*$ && "${SPEED_EXCLUSIVE_WINDOW:-}" == 1 ]] || exit 2
stage="$(cd "$(dirname "$0")" && pwd)"
session1="$stage/final-release"
session2="$stage/final-release-remainder"
mkdir "$session2" || exit 2
for name in vcandidate vfinal-main v0.17.1 v0.20.1; do ln -s "$session1/$name" "$session2/$name"; done
cp "$session1/manifest.json" "$session2/manifest.json"
runner_commit="$(node -e 'const r=require(process.argv[1]); process.stdout.write(r.runnerCommit)' \
  "$session1/runner-dependencies.json")"
[[ "$runner_commit" =~ ^[0-9a-f]{40}$ ]] || exit 2
export SPEED_G8_RUNNER_COMMIT="$runner_commit"
cd "$stage"
deadline=$((SECONDS + max_minutes * 60))
status=0

minutes_left() {
  local left=$((deadline - SECONDS))
  ((left > 0)) || return 124
  printf '%d.%02d' "$((left / 60))" "$((left % 60 * 100 / 60))"
}

left="$(minutes_left)" || status=$?
if ((status == 0)); then
  env SPEED_G8_PHONE_WARM_AA=1 SPEED_G8_OUTPUT_TAG=session2 \
    node "$stage/java-runner/run-g8.mjs" "$session2" run phone 212026 "$left" \
      > "$session2/session2-phone-warm-aa.log" 2>&1 || status=$?
fi
if ((status == 0)); then
  node "$stage/score-phone-warm-aa.mjs" "$session2" session2-phone-warm-aa \
    > "$session2/session2-phone-warm-aa-score.log" 2>&1 || status=$?
fi

run_remainder() {
  local language="$1" scope="$2" window=phone left
  [[ "$scope" == desktop ]] && window=desktop-a
  left="$(minutes_left)" || return 124
  env SPEED_G8_FINAL_RELEASE=1 SPEED_G8_FINAL_REMAINDER=1 SPEED_G8_LIVE_CONTROL=1 \
    SPEED_G8_OUTPUT_TAG=session2 SPEED_G8_LANGUAGE="$language" SPEED_JAVA_SCOPE="$scope" \
    node "$stage/java-runner/run-g8.mjs" "$session2" run "$window" 212026 "$left" \
      > "$session2/session2-final-$language-$scope.log" 2>&1
}

if ((status == 0)); then run_remainder csharp desktop || status=$?; fi
for language in java cpp typescript javascript; do
  for scope in phone desktop; do
    if ((status == 0)); then run_remainder "$language" "$scope" || status=$?; fi
  done
done

score_status=0
if ((status == 0)); then
  merged="$stage/final-release-merged-$(date -u +%Y%m%dT%H%M%SZ)"
  node "$stage/score-final-release-merged.mjs" "$stage" "$session1" "$session2" "$merged" \
    "$stage/frozen-baseline" "$session2/session2-phone-warm-aa-score.log" \
    > "$session2/score.merged.log" 2>&1 || score_status=$?
fi
tail -80 "$session2/score.merged.log" 2>/dev/null || true
echo "session_status=$status score_status=$score_status"
((status == 0 && score_status == 0))
