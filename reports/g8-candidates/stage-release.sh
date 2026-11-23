#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
case "$(node --version)" in v22.*) ;; *) exit 2 ;; esac
art=/root/ci/coord-artifacts
base="$art/tracecode-harness-0.17.3-d69fc275910c"
archive="$base.tgz"
sidecar="$archive.sha256"
expected=d69fc275910c39a99364e9bb5e2b79d47b920ac951840e3e6b29c02ed3e2c290
mapfile -t locks < <(find "$art" -maxdepth 1 -type f \
  -name 'tracecode-harness-0.17.3-d69fc275910c*package-lock.json' -print)
[[ -r "$archive" && -r "$sidecar" && "${#locks[@]}" == 1 ]] || exit 2
(cd "$art" && sha256sum --strict -c "$(basename "$sidecar")")
printf '%s  %s\n' "$expected" "$archive" | sha256sum --strict -c -
mkdir -p release-0.17.3
node stage.mjs "$archive" "$expected" none release-0.17.3/vrelease \
  0.17.1 '' "${locks[0]}"
cp release-0.17.3/vrelease/tracecode-harness-0.17.3.tgz \
  release-0.17.3/vrelease/candidate.tgz
