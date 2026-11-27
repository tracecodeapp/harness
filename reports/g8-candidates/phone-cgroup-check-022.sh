#!/usr/bin/env bash
# P27-F checks of the phone cgroup cap. Each operation is one ordinary heavy job, never a window.
#   dryrun <new-out-dir>                    condition 4 with R4, R5 and R7: main thread, Worker,
#                                           burst, concurrent and outside-loop ratios
#   killed <new-out-dir> [<session-022.sh> <0.21.0 tarball>]
#                                           R6: kill -9 the launcher while a Worker spins in the
#                                           scope; also shows that a live rig cgroup blocks a start
# Both require the host to have no rig cgroup at start and leave none at the end.
set -euo pipefail
source_dir="$(cd "$(dirname "$0")" && pwd)"
operation="${1:?Expected dryrun or killed}"
out="${2:?Expected a new absolute output directory}"
[[ "$out" == /* ]]
mkdir "$out"
cap="$source_dir/phone-cgroup-022.mjs"
probe="$source_dir/phone-throttle-probe-022.mjs"
run_id="${SPEED_RIG_022_CGROUP_RUN:-$(date -u +%Y%m%dt%H%M%S)-$$}"
stamp() { date -u +%FT%T.%3NZ; }
listing() {
  echo "find /sys/fs/cgroup -xdev -name 'h022-p27f-*':"
  find /sys/fs/cgroup -xdev -name 'h022-p27f-*'
  echo "systemctl list-units --all 'h022-p27f-*':"
  systemctl --no-pager list-units --all --plain --no-legend 'h022-p27f-*'
}
assert_empty_listing() {
  listing > "$1"
  cat "$1"
  [[ "$(grep -c 'h022-p27f-' "$1")" == 2 ]] || { echo "Rig cgroup or unit left: $1" >&2; exit 1; }
}

node "$cap" layout | tee "$out/layout.json"
node "$cap" assert-clean
assert_empty_listing "$out/listing-before.txt"

case "$operation" in
  dryrun)
    [[ "$#" == 2 ]]
    mkdir "$out/tmp"
    TMPDIR="$out/tmp" SPEED_RIG_022_CGROUP_RUN="$run_id-dry" node "$probe" dryrun "$out/dryrun"
    ;;
  killed)
    session_launcher="${3:-}"
    production="${4:-}"
    unit="h022-p27f-$run_id-killed.scope"
    mkdir "$out/tmp"
    TMPDIR="$out/tmp" SPEED_RIG_022_CGROUP_RUN="$run_id-killed" \
      node "$probe" hold "$out/hold" > "$out/hold.log" 2>&1 &
    launcher=$!
    for _ in $(seq 1 600); do
      [[ -s "$out/hold/ready.json" ]] && break
      kill -0 "$launcher" 2>/dev/null || { cat "$out/hold.log" >&2; exit 1; }
      sleep 0.1
    done
    [[ -s "$out/hold/ready.json" ]]
    cat "$out/hold.log"
    echo "$(stamp) scope live:"
    listing | tee "$out/listing-live.txt"
    cat "/sys/fs/cgroup/system.slice/$unit/cgroup.procs" | tee "$out/cgroup-procs-live.txt"
    # A live rig cgroup must block a new start.
    if node "$cap" assert-clean > "$out/assert-clean-live.log" 2>&1; then
      echo 'assert-clean passed with a live rig cgroup' >&2; exit 1
    fi
    grep -q 'Leftover rig cgroup' "$out/assert-clean-live.log"
    echo "$(stamp) assert-clean refused: $(grep -o 'Leftover rig cgroup[^"]*' "$out/assert-clean-live.log" | head -1)"
    if [[ -n "$session_launcher" ]]; then
      if bash "$session_launcher" selftest "$out/blocked-selftest" "$production" \
          > "$out/blocked-selftest.log" 2>&1; then
        echo 'The self-test started with a live rig cgroup' >&2; exit 1
      fi
      grep -q 'Leftover rig cgroup' "$out/blocked-selftest.log"
      [[ ! -e "$out/blocked-selftest" ]]
      echo "$(stamp) session-022.sh selftest refused to start with a live rig cgroup"
    fi
    echo "$(stamp) kill -9 $launcher"
    kill -9 "$launcher"
    wait "$launcher" 2>/dev/null || true
    killed_at="$(date +%s%N)"
    gone=
    for _ in $(seq 1 300); do
      if [[ "$(systemctl show -p LoadState --value "$unit")" == not-found &&
            ! -e "/sys/fs/cgroup/system.slice/$unit" ]] &&
         ! grep -lsqz "^H022_P27F_RUN=$unit\$" /proc/[0-9]*/environ; then
        gone=1; break
      fi
      sleep 0.1
    done
    [[ -n "$gone" ]] || { echo "$unit not removed 30 s after kill -9" >&2; listing >&2; exit 1; }
    echo "$(stamp) removed $(( ($(date +%s%N) - killed_at) / 1000000 )) ms after kill -9:" \
      "unit not-found, no cgroup directory, no process with H022_P27F_RUN=$unit"
    # The watchdog exits after the unit has been absent for 3 s.
    sleep 4
    cat "$out/hold/$unit-watchdog.log"
    watchdog_pid="$(sed -n 's/.*"watchdogPid": \([0-9]*\).*/\1/p' "$out/hold/ready.json" | head -1)"
    if [[ -n "$watchdog_pid" ]] && kill -0 "$watchdog_pid" 2>/dev/null; then
      echo "Watchdog $watchdog_pid still running" >&2; exit 1
    fi
    ;;
  *)
    echo "Unknown operation: $operation" >&2
    exit 2
    ;;
esac

node "$cap" assert-clean
assert_empty_listing "$out/listing-after.txt"
echo "$(stamp) $operation: nothing left under /sys/fs/cgroup"
