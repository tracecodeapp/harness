#!/usr/bin/env bash
set -euo pipefail
if [[ ${2:-} == --carry ]]; then
  sha=$(git rev-parse --short=12 HEAD)
  carried="/root/ci/coord-artifacts/feat-b3-python-$sha.tgz"
  if [[ -e "$carried" || -e "$carried.sha256" ]]; then
    echo "Carried candidate already exists: $carried" >&2
    exit 1
  fi
fi
if [[ ${1:-} == --public ]]; then
  pnpm build
  git diff HEAD --exit-code
fi
packed="$(mktemp -d "$PWD/.python-ordinary-pack.XXXXXX")"
trap 'rm -rf -- "$packed"' EXIT
pnpm pack --pack-destination "$packed"
tarball=("$packed"/*.tgz)
sha256sum "${tarball[0]}" | tee "$packed/pack.sha256"
if [[ ${2:-} == --carry ]]; then
  read -r digest _ < "$packed/pack.sha256"
  printf '%s  %s\n' "$digest" "$carried" > "$packed/carried.sha256"
  install -m 0444 "${tarball[0]}" "$carried"
  install -m 0444 "$packed/carried.sha256" "$carried.sha256"
  sha256sum --check "$carried.sha256"
  tarball=("$carried")
fi
tar -xzf "${tarball[0]}" -C "$packed"
node tests/test-python-ordinary-installed.mjs "$packed/package" "${1:-}"
