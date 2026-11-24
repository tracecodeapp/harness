#!/usr/bin/env bash
set -euo pipefail
scope="${1:?Expected phone, desktop or spot}"
probe_file="${2:?Expected shape probe JSON file}"
minutes="${3:-15}"
case "$scope" in phone|desktop|spot) ;; *) exit 2 ;; esac
[[ "$minutes" =~ ^[1-9][0-9]*$ ]] || exit 2
stage="$(cd "$(dirname "$0")" && pwd)"
out="$stage/python"
source "$stage/session-process-group.sh"
test -r "$probe_file" -a -r "$out/manifest.json"
(cd "$stage" && sha256sum --strict -c runner.sha256)

case "$scope" in
  phone)
    prefix="$out/shape-probe-phone-"
    command=(env SPEED_EXCLUSIVE_WINDOW=1 SPEED_G8_SHAPE_PROBE_FILE="$probe_file"
      node "$stage/python-runner/run-g8.mjs" "$stage/baseline" "$out" phone
      "$out/manifest.json" 212026 "$minutes")
    ;;
  desktop)
    prefix="$out/shape-probe-desktop-b-"
    command=(env SPEED_EXCLUSIVE_WINDOW=1 SPEED_G8_SHAPE_PROBE_FILE="$probe_file"
      node "$stage/python-runner/run-g8.mjs" "$stage/baseline" "$out" desktop-b
      "$out/manifest.json" 212026 "$minutes")
    ;;
  spot)
    prefix="$out/shape-probe-python-spot-"
    command=(env SPEED_EXCLUSIVE_WINDOW=1 SPEED_G8_SHAPE_PROBE_FILE="$probe_file"
      SPEED_G8_LANGUAGE=python SPEED_JAVA_SCOPE=spot SPEED_G8_LIVE_CONTROL=1
      node "$stage/java-runner/run-g8.mjs" "$out" run desktop-a 212026 "$minutes")
    ;;
esac

G8_RUN_PID=''
G8_RUN_PGID=''
on_stop() {
  local signal="$1" status="$2"
  trap - TERM INT HUP
  if [[ -n "$G8_RUN_PGID" ]]; then
    g8_stop_and_verify "$G8_RUN_PGID" "$prefix" "probe signal $signal" || true
  fi
  exit "$status"
}
trap 'on_stop TERM 143' TERM
trap 'on_stop INT 130' INT
trap 'on_stop HUP 129' HUP

status=0
g8_start_run_group "$prefix" /root/ci/bin/heavy-exclusive "${command[@]}"
wait "$G8_RUN_PID" || status=$?
g8_stop_and_verify "$G8_RUN_PGID" "$prefix" "probe exit $status"
trap - TERM INT HUP
exit "$status"
