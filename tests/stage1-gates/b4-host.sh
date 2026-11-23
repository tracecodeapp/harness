#!/usr/bin/env bash
# Run inside the build host's ar-harness job under heavy.
set -euo pipefail

candidate=$(git rev-parse HEAD)
artifact="/root/ci/coord-artifacts/feat-b4-js-ts-${candidate:0:12}.tgz"
build_output=$(mktemp -d)
trap 'rm -rf "$build_output"' EXIT

if [[ ! -e "$artifact" ]]; then
  git diff --exit-code HEAD
  corepack pnpm build >b4-build.log 2>&1 || { tail -60 b4-build.log; exit 1; }
  git diff --exit-code HEAD
  corepack pnpm pack --pack-destination "$build_output" >b4-pack.log 2>&1
  git diff --exit-code HEAD
  shopt -s nullglob
  packed=("$build_output"/*.tgz)
  [[ "${#packed[@]}" == 1 ]]
  read -r digest _ < <(sha256sum "${packed[0]}")
  install -m 0444 "${packed[0]}" "$artifact"
  printf '%s  %s\n' "$digest" "$artifact" >"$artifact.sha256"
  chmod 0444 "$artifact.sha256"
fi
sha256sum --check "$artifact.sha256"
read -r digest _ <"$artifact.sha256"
printf 'candidate=%s\nartifact=%s\nsha256=%s\n' "$candidate" "$artifact" "$digest"
gate_status=0
node tests/stage1-gates/b4-installed.mjs "$artifact" "$digest" || gate_status=$?
browser_status=0
corepack pnpm test:javascript-ses-provider-browser >b4-browser-suite.log 2>&1 || browser_status=$?
tail -20 b4-browser-suite.log
printf 'installed_gate=%s\nbrowser_suite=%s\n' "$gate_status" "$browser_status"
((gate_status == 0 && browser_status == 0))
