#!/usr/bin/env bash
set -uo pipefail
max_minutes="${1:?Expected total window minutes}"
[[ "$max_minutes" =~ ^[1-9][0-9]*$ ]] || exit 2
stage="$(cd "$(dirname "$0")" && pwd)"
baseline="$stage/frozen-baseline"
out="$stage/release-aa-closing"
(cd "$stage" && sha256sum --strict -c runner.sha256) || exit 2
(cd "$baseline" && sha256sum --strict -c "$stage/baseline-results.sha256") || exit 2
session_status=0
/root/ci/bin/heavy-exclusive env SPEED_EXCLUSIVE_WINDOW=1 SPEED_JOB_SOURCE_DIR="$PWD" \
  bash "$stage/session-release-python-warm.sh" "$max_minutes" || session_status=$?
score_status=0
node "$stage/score-release-python-warm.mjs" "$baseline" "$out" \
  > "$out/release-python-warm-score.log" 2>&1 || score_status=$?
tail -30 "$out/release-python-warm-score.log"
echo "session_status=$session_status score_status=$score_status"
((session_status == 0 && score_status == 0))
