#!/usr/bin/env bash
set -euo pipefail
stage="$(cd "$(dirname "$0")" && pwd)"
source "$stage/session-process-group.sh"

test_root="$(mktemp -d)"
prefix="$test_root/speed-seeded-"
cleanup() {
  if [[ -n "${G8_RUN_PGID:-}" ]]; then
    g8_stop_and_verify "$G8_RUN_PGID" "$prefix" test-cleanup || true
  fi
  rm -rf -- "$test_root"
}
trap cleanup EXIT

g8_start_run_group "$prefix" bash -c 'sleep 300 & wait'
[[ "$G8_RUN_PID" == "$G8_RUN_PGID" ]]
[[ -n "$(g8_group_pids "$G8_RUN_PGID")" ]]
[[ -n "$(g8_prefix_pids "$prefix")" ]]
g8_stop_and_verify "$G8_RUN_PGID" "$prefix" seeded-stop
[[ -z "$(g8_group_pids "$G8_RUN_PGID")" ]]
[[ -z "$(g8_prefix_pids "$prefix")" ]]
G8_RUN_PGID=''

echo 'session process-group lifecycle: OK'
