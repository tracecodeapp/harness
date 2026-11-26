#!/usr/bin/env bash
set -uo pipefail
stage="$(cd "$(dirname "$0")" && pwd)"
source "$stage/session-process-group.sh"
(cd "$stage" && sha256sum --strict -c runner.sha256) || exit 2
session3="$stage/final-release-session3-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir "$session3" || exit 2
plan="$session3/tail-plan.json"
node "$stage/final-release-tail-plan.mjs" "$stage/final-release-remainder" "$plan" \
  > "$session3/tail-plan.log" || exit 2
cap_minutes="$(node -e 'const p=require(process.argv[1]); process.stdout.write(String(p.capMinutes))' \
  "$plan")"
[[ "$cap_minutes" =~ ^[1-9][0-9]*$ ]] || exit 2
prefix="$session3/"
status=0
g8_start_run_group "$prefix" /usr/bin/timeout --foreground --signal=TERM --kill-after=15s \
  "${cap_minutes}m" /root/ci/bin/heavy-exclusive env SPEED_EXCLUSIVE_WINDOW=1 \
  bash "$stage/session-final-release-tail.sh" "$session3" "$plan" "$cap_minutes" || exit 2
wait "$G8_RUN_PID" || status=$?
g8_stop_and_verify "$G8_RUN_PGID" "$prefix" "Final tail speed exit $status" || exit 2
exit "$status"
