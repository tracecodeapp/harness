#!/usr/bin/env bash
set -uo pipefail
max_minutes="${1:?Expected total window minutes}"
[[ "$max_minutes" =~ ^[1-9][0-9]*$ && "${SPEED_EXCLUSIVE_WINDOW:-}" == 1 ]] || exit 2
stage="$(cd "$(dirname "$0")" && pwd)"
out="$stage/final-release"
test -r "$out/manifest.json" || exit 2
deadline=$((SECONDS + max_minutes * 60))
status=0

minutes_left() {
  local left=$((deadline - SECONDS))
  ((left > 0)) || return 124
  printf '%d.%02d' "$((left / 60))" "$((left % 60 * 100 / 60))"
}

run_python() {
  local kind="$1" scope="$2" window name left
  name="final-$scope"
  window=phone
  [[ "$scope" == desktop ]] && window=desktop-b
  left="$(minutes_left)" || return 124
  local -a run_env=(SPEED_G8_EXPERIMENT="$name")
  if [[ "$kind" == capture ]]; then
    run_env+=(SPEED_G8_CAPTURE_ONLY=1 SPEED_G8_FORCE_UNCAPTURED=1)
  else
    run_env+=(SPEED_G8_SESSION_CAPTURE_FILES="$out/capture-$name-samples.jsonl")
  fi
  env "${run_env[@]}" \
    node "$stage/python-runner/run-g8.mjs" "$stage/baseline" "$out" "$window" \
      "$out/manifest.json" 212026 "$left" > "$out/$kind-$name.log" 2>&1
}

run_language() {
  local language="$1" scope="$2" window left
  window=desktop-a
  [[ "$scope" == phone ]] && window=phone
  left="$(minutes_left)" || return 124
  env SPEED_G8_FINAL_RELEASE=1 SPEED_G8_LIVE_CONTROL=1 \
    SPEED_G8_LANGUAGE="$language" SPEED_JAVA_SCOPE="$scope" \
    node "$stage/java-runner/run-g8.mjs" "$out" run "$window" 212026 "$left" \
      > "$out/final-$language-$scope.log" 2>&1
}

# The expensive and newly changed runtime shapes go first, so a witness gap
# fails while most of the window is still available.
run_python capture phone || status=$?
if ((status == 0)); then run_python capture desktop || status=$?; fi
if ((status == 0)); then run_python measure phone || status=$?; fi
if ((status == 0)); then run_python measure desktop || status=$?; fi
for language in csharp java cpp typescript javascript; do
  for scope in phone desktop; do
    if ((status == 0)); then run_language "$language" "$scope" || status=$?; fi
  done
done

score_status=0
node "$stage/score-final-release.mjs" "$stage" "$out" "$stage/frozen-baseline" \
  > "$out/score.log" 2>&1 || score_status=$?
tail -60 "$out/score.log"
echo "session_status=$status score_status=$score_status"
((status == 0 && score_status == 0))
