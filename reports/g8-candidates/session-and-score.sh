#!/usr/bin/env bash
set -uo pipefail
case "${1:?Expected java, csharp or python}" in java|csharp|python) language="$1" ;; *) exit 2 ;; esac
max_minutes="${2:?Expected total window minutes}"
scope_mode="${3:-all}"
[[ "$max_minutes" =~ ^[1-9][0-9]*$ ]] || exit 2
stage="$(cd "$(dirname "$0")" && pwd)"
baseline="$stage/frozen-baseline"
out="$stage/$language"
source "$stage/session-process-group.sh"

(cd "$stage" && sha256sum --strict -c runner.sha256) || exit 2
(cd "$baseline" && sha256sum --strict -c "$stage/baseline-results.sha256") || exit 2
if [[ "${SPEED_G8_LIVE_CONTROL:-}" == 1 ]]; then
  bash "$stage/stage-live-control.sh" "$language" || exit 2
fi

session_status=0
case "$language" in
  python) run_output_prefix="$out/speed-" ;;
  *) run_output_prefix="$out/s-$language-" ;;
esac
G8_RUN_PID=''
G8_RUN_PGID=''
stop_requested=0
on_stop() {
  local signal="$1" status="$2"
  trap - TERM INT HUP
  stop_requested=1
  if [[ -n "$G8_RUN_PGID" ]]; then
    g8_stop_and_verify "$G8_RUN_PGID" "$run_output_prefix" "signal $signal" || true
  fi
  exit "$status"
}
trap 'on_stop TERM 143' TERM
trap 'on_stop INT 130' INT
trap 'on_stop HUP 129' HUP

g8_start_run_group "$run_output_prefix" /root/ci/bin/heavy-exclusive \
  env SPEED_EXCLUSIVE_WINDOW=1 bash "$stage/session.sh" \
  "$language" "$max_minutes" "$scope_mode" || exit 2
wait "$G8_RUN_PID" || session_status=$?
g8_stop_and_verify "$G8_RUN_PGID" "$run_output_prefix" \
  "$([[ "$session_status" == 0 ]] && echo complete || echo "session exit $session_status")" || exit 2
G8_RUN_PID=''
G8_RUN_PGID=''
trap - TERM INT HUP

score_status=0
node "$stage/score.mjs" "$baseline" "$out" "$language" > "$out/score.log" 2>&1 || score_status=$?
tail -40 "$out/score.log"
echo "session_status=$session_status score_status=$score_status"
((session_status == 0 && score_status == 0))
