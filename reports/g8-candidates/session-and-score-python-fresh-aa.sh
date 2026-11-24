#!/usr/bin/env bash
set -uo pipefail
max_minutes="${1:?Expected total window minutes}"
[[ "$max_minutes" =~ ^[1-9][0-9]*$ ]] || exit 2
stage="$(cd "$(dirname "$0")" && pwd)"
(cd "$stage" && sha256sum --strict -c runner.sha256) || exit 2
bash "$stage/stage-python-fresh-aa.sh" || exit 2
session_status=0
/root/ci/bin/heavy-exclusive env SPEED_EXCLUSIVE_WINDOW=1 SPEED_JOB_SOURCE_DIR="$PWD" \
  bash "$stage/session-python-fresh-aa.sh" "$max_minutes" || session_status=$?
score_status=0
node "$stage/score-python-fresh-aa.mjs" "$stage/python-fresh-aa" \
  > "$stage/python-fresh-aa/score.log" 2>&1 || score_status=$?
tail -30 "$stage/python-fresh-aa/score.log"
echo "session_status=$session_status score_status=$score_status"
((session_status == 0 && score_status == 0))
