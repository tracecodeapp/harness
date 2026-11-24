#!/usr/bin/env bash
set -euo pipefail
scope="${1:?Expected phone, desktop or spot}"
probe_file="${2:?Expected shape probe JSON file}"
minutes="${3:-20}"
case "$scope" in phone|desktop|spot) ;; *) exit 2 ;; esac
[[ "$minutes" =~ ^[1-9][0-9]*$ ]] || exit 2
stage="$(cd "$(dirname "$0")" && pwd)"
out="$stage/csharp"
source "$stage/session-process-group.sh"
test -r "$probe_file" -a -r "$out/vcandidate/candidate.json"
(cd "$stage" && sha256sum --strict -c runner.sha256)
bash "$stage/stage-live-control.sh" csharp

case "$scope" in
  phone) window=phone ;;
  desktop|spot) window=desktop-a ;;
esac
prefix="$out/shape-probe-csharp-$scope-"
command=(env SPEED_G8_SHAPE_PROBE_FILE="$probe_file" SPEED_G8_LANGUAGE=csharp
  SPEED_JAVA_SCOPE="$scope" SPEED_G8_LIVE_CONTROL=1
  node "$stage/java-runner/run-g8.mjs" "$out" run "$window" 212026 "$minutes")

G8_RUN_PID=''
G8_RUN_PGID=''
on_stop() {
  local signal="$1" status="$2"
  trap - TERM INT HUP
  if [[ -n "$G8_RUN_PGID" ]]; then
    g8_stop_and_verify "$G8_RUN_PGID" "$prefix" "C# probe signal $signal" || true
  fi
  exit "$status"
}
trap 'on_stop TERM 143' TERM
trap 'on_stop INT 130' INT
trap 'on_stop HUP 129' HUP

status=0
g8_start_run_group "$prefix" /root/ci/bin/heavy-exclusive "${command[@]}"
wait "$G8_RUN_PID" || status=$?
g8_stop_and_verify "$G8_RUN_PGID" "$prefix" "C# probe exit $status"
trap - TERM INT HUP
exit "$status"
