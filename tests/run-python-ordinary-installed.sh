#!/usr/bin/env bash
set -euo pipefail
packed="$(mktemp -d "$PWD/.python-ordinary-pack.XXXXXX")"
trap 'rm -rf -- "$packed"' EXIT
pnpm pack --pack-destination "$packed"
tarball=("$packed"/*.tgz)
sha256sum "${tarball[0]}"
tar -xzf "${tarball[0]}" -C "$packed"
node tests/test-python-ordinary-installed.mjs "$packed/package"
