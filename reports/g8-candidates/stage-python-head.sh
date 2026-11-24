#!/usr/bin/env bash
set -euo pipefail
expected="${1:?Expected exact source commit}"
label="${2:?Expected staging label}"
archive="${3:?Expected registered archive basename}"
[[ "$expected" =~ ^[0-9a-f]{40}$ && "$label" =~ ^[0-9a-z-]+$ &&
  "$archive" =~ ^[0-9A-Za-z._-]+[.]tgz$ ]] || exit 2

stage="$(cd "$(dirname "$0")" && pwd)"
src="$(git rev-parse HEAD)"
test "$src" = "$expected"
art=/root/ci/coord-artifacts
out="$stage/python-$label"
pack="$stage/python-control-pack-$label"
concurrent_pack="$stage/python-candidate-pack-$label"
test ! -e "$out" -a ! -e "$pack" -a ! -e "$concurrent_pack" -a ! -e "$art/$archive"
mkdir -p "$out" "$pack" "$concurrent_pack"

# ar-harness owns these two disposable checkout logs.
printf '\n/install.log\n/run.log\n' >> "$(git rev-parse --git-path info/exclude)"
git diff --exit-code
corepack pnpm run build
git diff --exit-code
corepack pnpm pack --pack-destination "$concurrent_pack"
mapfile -t candidate_tarballs < <(find "$concurrent_pack" -maxdepth 1 -type f -name '*.tgz')
test "${#candidate_tarballs[@]}" = 1
cp "${candidate_tarballs[0]}" "$art/$archive"
(cd "$art" && sha256sum "$archive" > "$archive.sha256")
read -r concurrent _ < "$art/$archive.sha256"
node "$stage/stage.mjs" "$art/$archive" "$concurrent" "$src" "$out/vconcurrent"

node "$stage/python-runner/sequential-overlay.mjs" "$PWD" "$src"
git diff --check
git diff --binary > "$pack/sequential-overlay.diff"
corepack pnpm run build
corepack pnpm pack --pack-destination "$pack"
mapfile -t control_tarballs < <(find "$pack" -maxdepth 1 -type f -name '*.tgz')
test "${#control_tarballs[@]}" = 1
sha256sum "${control_tarballs[0]}" | tee "$pack/pack.sha256"
date -u +%FT%TZ > "$pack/packed-at.utc"
read -r sequential _ < "$pack/pack.sha256"
node "$stage/stage.mjs" "${control_tarballs[0]}" "$sequential" "$src" "$out/vsequential"

cp "$out/vconcurrent"/tracecode-harness-*.tgz "$out/vconcurrent/candidate.tgz"
ln -s vconcurrent "$out/vcandidate"
ln -s vconcurrent "$out/vconcurrent-deploy"
for version in 0.17.1 0.20.1; do
  ln -s "../historical/v$version" "$out/v$version"
done
node --input-type=module - "$out" "$pack" "$src" <<'JS'
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
const [out, pack, commit] = process.argv.slice(2);
const load = (name) => JSON.parse(readFileSync(join(out, name, 'candidate.json')));
const concurrent = load('vconcurrent');
const sequential = load('vsequential');
sequential.packedAt = readFileSync(join(pack, 'packed-at.utc'), 'utf8').trim();
sequential.overlayDiffSha256 = createHash('sha256')
  .update(readFileSync(join(pack, 'sequential-overlay.diff'))).digest('hex');
const manifest = { concurrent, 'concurrent-deploy': concurrent, sequential };
for (const row of Object.values(manifest)) {
  if (row.commit !== commit) throw new Error('Staged source commit differs');
}
writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify(manifest));
JS
ln -sfn "python-$label" "$stage/python"
test "$(readlink -f "$stage/python")" = "$(readlink -f "$out")"
echo "registered=$art/$archive sha256=$concurrent source=$src"
