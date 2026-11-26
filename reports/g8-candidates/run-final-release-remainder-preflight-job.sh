#!/usr/bin/env bash
set -euo pipefail
stage="$(cd "$(dirname "$0")" && pwd)"
source "$stage/session-process-group.sh"
prefix="$stage/final-release-remainder-preflight-"
g8_start_run_group "$prefix" /root/ci/bin/heavy env SPEED_G8_PREFLIGHT_ORDINARY=1 \
  bash "$stage/preflight-final-release-remainder.sh" "${1:-25}"
status=0
wait "$G8_RUN_PID" || status=$?
g8_stop_and_verify "$G8_RUN_PGID" "$prefix" "Final remainder preflight exit $status"
exit "$status"
