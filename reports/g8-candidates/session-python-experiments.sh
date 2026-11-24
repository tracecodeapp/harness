#!/usr/bin/env bash
set -euo pipefail
max_minutes="${1:?Expected total window minutes}"
[[ "$max_minutes" =~ ^[1-9][0-9]*$ && "${SPEED_EXCLUSIVE_WINDOW:-}" == 1 ]] || exit 2
stage="$(cd "$(dirname "$0")" && pwd)"
out="$stage/python-experiments"
test -r "$out/manifest.json"
deadline=$((SECONDS + max_minutes * 60))

run_experiment() {
  local name="$1" window="$2" status=0 left
  left=$((deadline - SECONDS))
  if ((left <= 0)); then
    echo "Window elapsed before $name"
    return 1
  fi
  SPEED_G8_EXPERIMENT="$name" node "$stage/python-runner/run-g8.mjs" \
    "$stage/baseline" "$out" "$window" "$out/manifest.json" 212026 \
    "$((left / 60)).$(printf '%02d' "$((left % 60 * 100 / 60))")" \
    > "$out/$name.log" 2>&1 || status=$?
  tail -8 "$out/$name.log"
  return "$status"
}

run_experiment e1 phone
run_experiment e2 phone
run_experiment ed1 desktop-b
node "$stage/score-python-experiments.mjs" "$out" > "$out/score.log"
tail -40 "$out/score.log"
