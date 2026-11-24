#!/usr/bin/env bash

# Lifecycle helper for one G8 timed session. The caller owns the process group;
# every descendant also receives an exact output-prefix marker so verification
# can detect a process that deliberately or accidentally leaves the group.
g8_group_pids() {
  local pgid="$1"
  ps -eo pid=,pgid= | awk -v wanted="$pgid" '$2 == wanted { print $1 }'
}

g8_prefix_pids() {
  local prefix="$1" environ pid
  for environ in /proc/[0-9]*/environ; do
    [[ -r "$environ" ]] || continue
    pid="${environ#/proc/}"
    pid="${pid%/environ}"
    [[ "$pid" == "$$" || "$pid" == "$PPID" ]] && continue
    if tr '\0' '\n' < "$environ" 2>/dev/null |
        grep -Fqx -- "SPEED_G8_RUN_OUTPUT_PREFIX=$prefix"; then
      echo "$pid"
    fi
  done
}

g8_wait_absent() {
  local pgid="$1" prefix="$2" attempts="${3:-50}" group prefix_pids
  while ((attempts-- > 0)); do
    group="$(g8_group_pids "$pgid")"
    prefix_pids="$(g8_prefix_pids "$prefix")"
    [[ -z "$group" && -z "$prefix_pids" ]] && return 0
    sleep 0.1
  done
  return 1
}

g8_signal_owned() {
  local signal="$1" pgid="$2" prefix="$3" pid
  kill "-$signal" -- "-$pgid" 2>/dev/null || true
  while read -r pid; do
    [[ -n "$pid" ]] && kill "-$signal" "$pid" 2>/dev/null || true
  done < <(g8_prefix_pids "$prefix")
}

g8_stop_and_verify() {
  local pgid="$1" prefix="$2" reason="$3" group prefix_pids
  g8_signal_owned TERM "$pgid" "$prefix"
  if ! g8_wait_absent "$pgid" "$prefix" 30; then
    g8_signal_owned KILL "$pgid" "$prefix"
  fi
  if ! g8_wait_absent "$pgid" "$prefix" 30; then
    group="$(g8_group_pids "$pgid" | paste -sd, -)"
    prefix_pids="$(g8_prefix_pids "$prefix" | paste -sd, -)"
    echo "G8 run cleanup failed ($reason): pgid=$pgid group_pids=${group:-none} prefix_pids=${prefix_pids:-none}" >&2
    return 1
  fi
  echo "G8 run group released ($reason): pgid=$pgid prefix=$prefix" >&2
}

g8_start_run_group() {
  local prefix="$1"
  shift
  setsid env SPEED_G8_RUN_OUTPUT_PREFIX="$prefix" "$@" &
  G8_RUN_PID=$!
  G8_RUN_PGID=''
  local attempts=50 observed
  while ((attempts-- > 0)); do
    observed="$(ps -o pgid= -p "$G8_RUN_PID" 2>/dev/null | tr -d ' ')"
    if [[ "$observed" == "$G8_RUN_PID" ]]; then
      G8_RUN_PGID="$observed"
      return 0
    fi
    kill -0 "$G8_RUN_PID" 2>/dev/null || break
    sleep 0.02
  done
  echo "G8 run did not enter its own process group: pid=$G8_RUN_PID pgid=${observed:-missing}" >&2
  kill -TERM "$G8_RUN_PID" 2>/dev/null || true
  wait "$G8_RUN_PID" 2>/dev/null || true
  return 1
}
