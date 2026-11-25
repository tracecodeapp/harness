#!/usr/bin/env bash
set -euo pipefail
expected=2ddacad971e8def9c41668ccfc5d070870c98681
archive=python-sprime-registered-2ddacad971e8.tgz
stage="$(cd "$(dirname "$0")" && pwd)"
art=/root/ci/coord-artifacts
out="$stage/python-confirmation"
test ! -e "$out"
test -r "$art/$archive" -a -r "$art/$archive.sha256"
read -r digest named < "$art/$archive.sha256"
test "$named" = "$archive"
test "$digest" = "$(sha256sum "$art/$archive" | cut -d' ' -f1)"
mkdir "$out"
node "$stage/stage.mjs" "$art/$archive" "$digest" "$expected" "$out/vsprime"
ln -s ../historical/v0.17.1 "$out/v0.17.1"
node --input-type=module - "$out" "$expected" <<'JS'
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const [out, expected] = process.argv.slice(2);
const candidate = JSON.parse(readFileSync(join(out, 'vsprime', 'candidate.json')));
if (candidate.commit !== expected) throw new Error('Candidate commit differs');
writeFileSync(join(out, 'manifest.json'), JSON.stringify({ sprime: candidate }, null, 2) + '\n');
JS
echo "registered=$art/$archive sha256=$digest source=$expected"
