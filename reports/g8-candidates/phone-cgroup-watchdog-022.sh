#!/usr/bin/env bash
# Removes one rig scope when the process that launched it dies, including by kill -9 (P27-F, R6).
# Usage: phone-cgroup-watchdog-022.sh <launcher-pid> <h022-p27f-<run-id>.scope>
# It acts only on the unit named here, and only with `systemctl kill`; it never touches a cgroup file.
set -u
launcher="${1:?launcher pid}"
unit="${2:?unit}"
[[ "$launcher" =~ ^[0-9]+$ && "$unit" =~ ^h022-p27f-[a-z0-9][a-z0-9-]*\.scope$ ]] || exit 2

start_time() { sed 's/.*) //' "/proc/$1/stat" 2>/dev/null | cut -d' ' -f20; }
state_of() { sed 's/.*) //' "/proc/$1/stat" 2>/dev/null | cut -d' ' -f1; }
launcher_start="$(start_time "$launcher")"
[[ -n "$launcher_start" ]] || launcher_start=gone
echo "$(date -u +%FT%T.%3NZ) watching launcher $launcher for $unit"

alive() {
  [[ "$launcher_start" != gone && "$(start_time "$launcher")" == "$launcher_start" &&
     "$(state_of "$launcher")" != Z ]]
}
while alive; do sleep 0.2; done

echo "$(date -u +%FT%T.%3NZ) launcher $launcher exited"
# Keep trying for up to 30 s: systemd-run may still be registering the scope when the launcher dies.
# Stop once the unit has been absent for 3 s in a row.
absent=0
for _ in $(seq 1 150); do
  state="$(systemctl show -p LoadState --value "$unit" 2>/dev/null)"
  if [[ "$state" == loaded ]]; then
    absent=0
    systemctl kill --signal=SIGKILL "$unit" 2>/dev/null &&
      echo "$(date -u +%FT%T.%3NZ) systemctl kill --signal=SIGKILL $unit"
  else
    absent=$((absent + 1))
    if ((absent >= 15)); then
      echo "$(date -u +%FT%T.%3NZ) $unit absent; watchdog exits"
      exit 0
    fi
  fi
  sleep 0.2
done
echo "$(date -u +%FT%T.%3NZ) $unit still loaded after 30 s" >&2
exit 1
