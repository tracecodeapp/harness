#!/usr/bin/env bash
set -euo pipefail
stage="$(cd "$(dirname "$0")" && pwd)"
control="$stage/historical/v0.17.1"
out="$stage/python-fresh-aa"
expected=e3373fa0b3e1bd6e5c167f536051a51e28344fe4e31130cc4b1c46a3a44c7df3
test -r "$control/candidate.json"
printf '%s  %s\n' "$expected" "$control/tracecode-harness-0.17.1.tgz" | sha256sum --strict -c -
mkdir -p "$out"
ln -sfn ../historical/v0.17.1 "$out/v0.17.1"
test "$(readlink -f "$out/v0.17.1")" = "$(readlink -f "$control")"
