#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 3 || $# -gt 4 || ${2:-} != --rev || ( $# == 4 && ${4:-} != --force ) ]]; then
  echo "Usage: scripts/gates/run-cell.sh <cell> --rev <commit> [--force]" >&2
  exit 2
fi
if [[ ! ${HEAVY_JOB_LANE:-} =~ ^h022-[a-z0-9-]+$ || ! -x /root/ci/bin/heavy ]]; then
  echo "Run on agentrunner with HEAVY_JOB_LANE=h022-<lane>." >&2
  exit 2
fi
if [[ ! $1 =~ ^[a-z0-9-]+$ ]]; then
  echo "Use a cell id from scripts/gates/cells.json." >&2
  exit 2
fi

repo=$(git rev-parse --show-toplevel)
rev=$(git rev-parse --verify --end-of-options "$3^{commit}")
work_root=/root/ci/gate-work
mkdir -p "$work_root"
work=$(mktemp -d "$work_root/$1.XXXXXX")
cleanup() {
  rm -f "$work/host-pins.json"
  if [[ -e $work/checkout/.git ]]; then
    git -C "$repo" worktree remove --force "$work/checkout"
  fi
  rmdir "$work"
}
trap cleanup EXIT
git -C "$repo" worktree add --quiet --detach "$work/checkout" "$rev"
cd "$work/checkout"
GATE_PREFLIGHT_PINS="$work/host-pins.json" node scripts/gates/run-cell.mjs "$1" "$rev" "${4:-}"
