#!/usr/bin/env bash
set -euo pipefail
expected="${1:?Expected exact source commit}"
label="${2:?Expected staging label}"
archive="${3:?Expected registered archive basename}"
[[ "$expected" =~ ^[0-9a-f]{40}$ && "$label" =~ ^[0-9a-z-]+$ &&
  "$archive" =~ ^[0-9A-Za-z._-]+[.]tgz$ ]] || exit 2

stage="$(cd "$(dirname "$0")" && pwd)"
art=/root/ci/coord-artifacts
source_archive="$art/$archive"
sidecar="$source_archive.sha256"
out="$stage/csharp-$label"
test -r "$source_archive" -a -r "$sidecar" -a ! -e "$out"
(cd "$art" && sha256sum --strict -c "$(basename "$sidecar")")
read -r digest _ < "$sidecar"
[[ "$digest" =~ ^[0-9a-f]{64}$ ]]

mkdir -p "$out"
node "$stage/stage.mjs" "$source_archive" "$digest" "$expected" "$out/vcandidate"
cp "$out"/vcandidate/tracecode-harness-*.tgz "$out/vcandidate/candidate.tgz"
printf '%s  %s\n' "$digest" "$out/vcandidate/candidate.tgz" | sha256sum --strict -c -
ln -sfn "csharp-$label" "$stage/csharp"
test "$(readlink -f "$stage/csharp")" = "$(readlink -f "$out")"
echo "registered=$source_archive sha256=$digest source=$expected"
cat "$out/vcandidate/candidate.json"
