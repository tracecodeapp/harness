#!/usr/bin/env bash
set -euo pipefail
expected="${1:?Expected exact final-main commit}"
archive="${2:?Expected registered archive basename}"
[[ "$expected" =~ ^[0-9a-f]{40}$ && "$archive" =~ ^[0-9A-Za-z._-]+[.]tgz$ ]] || exit 2

stage="$(cd "$(dirname "$0")" && pwd)"
art=/root/ci/coord-artifacts
source_archive="$art/$archive"
sidecar="$source_archive.sha256"
out="$stage/final-release"
test -r "$source_archive" -a -r "$sidecar" -a ! -e "$out"
(cd "$art" && sha256sum --strict -c "$(basename "$sidecar")")
read -r digest named < "$sidecar"
test "$named" = "$archive"
[[ "$digest" =~ ^[0-9a-f]{64}$ ]]

mkdir "$out"
node "$stage/stage.mjs" "$source_archive" "$digest" "$expected" "$out/vcandidate"
cp "$out"/vcandidate/tracecode-harness-*.tgz "$out/vcandidate/candidate.tgz"
printf '%s  %s\n' "$digest" "$out/vcandidate/candidate.tgz" | sha256sum --strict -c -
ln -s vcandidate "$out/vfinal-main"
ln -s ../historical/v0.17.1 "$out/v0.17.1"
ln -s ../historical/v0.20.1 "$out/v0.20.1"
node --input-type=module - "$out" "$expected" "$digest" <<'JS'
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const [out, expected, digest] = process.argv.slice(2);
const candidate = JSON.parse(readFileSync(join(out, 'vcandidate', 'candidate.json')));
assert.equal(candidate.commit, expected);
assert.equal(candidate.tarballSha256, digest);
writeFileSync(join(out, 'manifest.json'), JSON.stringify({ 'final-main': candidate }, null, 2) + '\n');
JS
echo "registered=$source_archive sha256=$digest source=$expected"
