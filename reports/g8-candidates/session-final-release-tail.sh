#!/usr/bin/env bash
set -uo pipefail
session3="${1:?Expected Session 3 directory}"
plan="${2:?Expected tail plan}"
max_minutes="${3:?Expected tail cap minutes}"
[[ "$max_minutes" =~ ^[1-9][0-9]*$ && "${SPEED_EXCLUSIVE_WINDOW:-}" == 1 ]] || exit 2
stage="$(cd "$(dirname "$0")" && pwd)"
session1="$stage/final-release"
session2="$stage/final-release-remainder"
test -d "$session3" -a -r "$plan" || exit 2
for name in vcandidate vfinal-main v0.17.1 v0.20.1; do ln -s "$session1/$name" "$session3/$name"; done
cp "$session1/manifest.json" "$session3/manifest.json"
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

group_count() {
  node -e 'const p=require(process.argv[1]); const s=p.sessions.find(x => x.language === process.argv[2] && x.scope === process.argv[3]); process.stdout.write(String(s.groups.length))' \
    "$plan" "$1" "$2"
}

run_tail() {
  local language="$1" scope="$2" window=phone left
  [[ "$(group_count "$language" "$scope")" == 0 ]] && return 0
  [[ "$scope" == desktop ]] && window=desktop-a
  left="$(minutes_left)" || return 124
  env SPEED_G8_FINAL_RELEASE=1 SPEED_G8_FINAL_REMAINDER=1 SPEED_G8_LIVE_CONTROL=1 \
    SPEED_G8_FINAL_TAIL_FILE="$plan" SPEED_G8_OUTPUT_TAG=session3 \
    SPEED_G8_LANGUAGE="$language" SPEED_JAVA_SCOPE="$scope" \
    node "$stage/java-runner/run-g8.mjs" "$session3" run "$window" 212026 "$left" \
      > "$session3/session3-final-$language-$scope.log" 2>&1
}

run_tail csharp desktop || status=$?
for language in java cpp typescript javascript; do
  for scope in phone desktop; do
    if ((status == 0)); then run_tail "$language" "$scope" || status=$?; fi
  done
done

score_status=0
if ((status == 0)); then
  merged="$stage/final-release-merged-$(date -u +%Y%m%dT%H%M%SZ)"
  node "$stage/score-final-release-merged.mjs" "$stage" "$session1" "$session2" "$merged" \
    "$stage/frozen-baseline" "$session2/session2-phone-warm-aa-score.log" "$session3" \
    > "$session3/score.merged.log" 2>&1 || score_status=$?
fi
tail -80 "$session3/score.merged.log" 2>/dev/null || true
echo "session_status=$status score_status=$score_status"
((status == 0 && score_status == 0))
