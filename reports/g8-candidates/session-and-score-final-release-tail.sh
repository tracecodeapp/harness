#!/usr/bin/env bash
set -uo pipefail
stage="$(cd "$(dirname "$0")" && pwd)"
source "$stage/session-process-group.sh"
(cd "$stage" && sha256sum --strict -c runner.sha256) || exit 2
source_session3="${1:-}"
[[ -z "$source_session3" || -d "$source_session3" ]] || exit 2
sample_session=3
if [[ -n "$source_session3" ]]; then sample_session=4; fi
session_dir="$stage/final-release-session${sample_session}-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir "$session_dir" || exit 2
plan="$session_dir/tail-plan.json"
plan_args=("$stage/final-release-remainder" "$plan")
if [[ -n "$source_session3" ]]; then plan_args+=("$source_session3"); fi
node "$stage/final-release-tail-plan.mjs" "${plan_args[@]}" \
  > "$session_dir/tail-plan.log" || exit 2
cap_minutes="$(node -e 'const p=require(process.argv[1]); process.stdout.write(String(p.capMinutes))' \
  "$plan")"
[[ "$cap_minutes" =~ ^[1-9][0-9]*$ ]] || exit 2
prefix="$session_dir/"
status=0
if [[ -n "$source_session3" ]]; then export SPEED_G8_SOURCE_SESSION3="$source_session3"; fi
g8_start_run_group "$prefix" /usr/bin/timeout --foreground --signal=TERM --kill-after=15s \
  "${cap_minutes}m" /root/ci/bin/heavy-exclusive env SPEED_EXCLUSIVE_WINDOW=1 \
  bash "$stage/session-final-release-tail.sh" "$session_dir" "$plan" "$cap_minutes" || exit 2
wait "$G8_RUN_PID" || status=$?
g8_stop_and_verify "$G8_RUN_PGID" "$prefix" "Final tail speed exit $status" || exit 2
exit "$status"
