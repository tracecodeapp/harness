#!/usr/bin/env bash
set -euo pipefail
if [[ ${1:-} == --public ]]; then
  pnpm build
  git diff HEAD --exit-code
fi
packed="$(mktemp -d "$PWD/.python-ordinary-pack.XXXXXX")"
trap 'rm -rf -- "$packed"' EXIT
pnpm pack --pack-destination "$packed"
tarball=("$packed"/*.tgz)
sha256sum "${tarball[0]}"
if [[ ${2:-} == --carry ]]; then
  sha=$(git rev-parse --short=12 HEAD)
  carried="/root/ci/coord-artifacts/feat-b3-python-$sha.tgz"
  if [[ -e "$carried" ]]; then
    cmp "${tarball[0]}" "$carried"
  else
    install -m 0444 "${tarball[0]}" "$carried"
  fi
  sha256sum "$carried"
fi
tar -xzf "${tarball[0]}" -C "$packed"
node tests/test-python-ordinary-installed.mjs "$packed/package" "${1:-}"
