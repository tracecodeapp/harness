#!/usr/bin/env bash
set -uo pipefail
max_minutes="${1:?Expected total window minutes}"
[[ "$max_minutes" =~ ^[1-9][0-9]*$ ]] || exit 2
stage="$(cd "$(dirname "$0")" && pwd)"
out="$stage/final-release"
source "$stage/session-process-group.sh"
(cd "$stage" && sha256sum --strict -c runner.sha256) || exit 2

prefix="$out/"
status=0
g8_start_run_group "$prefix" /usr/bin/timeout --foreground --signal=TERM --kill-after=15s "${max_minutes}m" \
  /root/ci/bin/heavy-exclusive env SPEED_EXCLUSIVE_WINDOW=1 \
  bash "$stage/session-final-release.sh" "$max_minutes" || exit 2
wait "$G8_RUN_PID" || status=$?
g8_stop_and_verify "$G8_RUN_PGID" "$prefix" "Final release speed exit $status" || exit 2
exit "$status"
