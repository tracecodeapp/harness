#!/usr/bin/env bash
set -uo pipefail
max_minutes="${1:?Expected total window minutes}"
[[ "$max_minutes" =~ ^[1-9][0-9]*$ && "${SPEED_EXCLUSIVE_WINDOW:-}" == 1 ]] || exit 2
stage="$(cd "$(dirname "$0")" && pwd)"
out="$stage/python-confirmation"
test -r "$out/manifest.json" || exit 2
deadline=$((SECONDS + max_minutes * 60))
session_status=0

run_plan() {
  local prefix="$1" name="$2" window="$3" status=0 left
  local -a run_env
  left=$((deadline - SECONDS))
  if ((left <= 0)); then
    echo "Window elapsed before $prefix $name"
    return 124
  fi
  run_env=(SPEED_G8_EXPERIMENT="$name")
  if [[ "$prefix" == capture ]]; then
    run_env+=(SPEED_G8_CAPTURE_ONLY=1 SPEED_G8_FORCE_UNCAPTURED=1)
  else
    run_env+=(SPEED_G8_SESSION_CAPTURE_FILES="$out/capture-$name-samples.jsonl")
  fi
  env "${run_env[@]}" node "$stage/python-runner/run-g8.mjs" \
      "$stage/baseline" "$out" "$window" "$out/manifest.json" 212026 \
      "$((left / 60)).$(printf '%02d' "$((left % 60 * 100 / 60))")" \
      > "$out/$prefix-$name.log" 2>&1 || status=$?
  tail -12 "$out/$prefix-$name.log"
  return "$status"
}

run_plan capture sprime-phone phone || session_status=$?
if ((session_status == 0)); then run_plan capture sprime-desktop desktop-b || session_status=$?; fi
if ((session_status == 0)); then run_plan experiment sprime-phone phone || session_status=$?; fi
if ((session_status == 0)); then run_plan experiment sprime-desktop desktop-b || session_status=$?; fi

score_status=0
node "$stage/score-python-confirmation.mjs" "$out" > "$out/score.log" 2>&1 || score_status=$?
tail -40 "$out/score.log"
echo "session_status=$session_status score_status=$score_status"
((session_status == 0 && score_status == 0))
