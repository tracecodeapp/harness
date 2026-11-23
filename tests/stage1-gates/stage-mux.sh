#!/usr/bin/env bash
set -euo pipefail
repo=${1:?Mux repository}
output=${2:?External directory}
pin=82888fb7bc95272e43477ab5ae62b95cc28e9008
mkdir -p "$output"
for name in judge-browser-slot project-wire; do
  git -C "$repo" show "$pin:src/runners/$name.ts" >"$output/$name.ts"
done
printf '%s\n' "$pin" >"$output/mux.sha"
