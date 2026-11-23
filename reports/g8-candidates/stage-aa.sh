#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
release=release-0.17.3/vrelease
historical=historical/v0.17.1
out=release-aa
release_sha=d69fc275910c39a99364e9bb5e2b79d47b920ac951840e3e6b29c02ed3e2c290
historical_sha=e3373fa0b3e1bd6e5c167f536051a51e28344fe4e31130cc4b1c46a3a44c7df3

printf '%s  %s\n' "$release_sha" "$release/candidate.tgz" | sha256sum --strict -c -
printf '%s  %s\n' "$historical_sha" "$historical/tracecode-harness-0.17.1.tgz" | sha256sum --strict -c -
test -r "$release/candidate.json" -a -r "$historical/candidate.json"
mkdir -p "$out"
ln -sfn ../release-0.17.3/vrelease "$out/vrelease"
ln -sfn ../historical/v0.17.1 "$out/v0.17.1"
test "$(readlink -f "$out/vrelease")" = "$(readlink -f "$release")"
test "$(readlink -f "$out/v0.17.1")" = "$(readlink -f "$historical")"
