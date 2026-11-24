#!/usr/bin/env bash
set -euo pipefail
stage="$(cd "$(dirname "$0")" && pwd)"
src="$(git rev-parse HEAD)"
expected=3dfc7dc13de0c8d9cfc325197d10dff8a16051cb
test "$src" = "$expected"
art=/root/ci/coord-artifacts
archive=feat-b3-python-3dfc7dc13de0.tgz
concurrent=6df28a9148984fbffd0eba023a77cd441bde0a40b2cbfcb0982a149eb0a46850
(cd "$art" && sha256sum -c "$archive.sha256")
out="$stage/python-3dfc7dc1"
pack="$stage/python-control-pack-3dfc7dc1"
test ! -e "$out" -a ! -e "$pack"
mkdir -p "$out" "$pack"
node "$stage/stage.mjs" "$art/$archive" "$concurrent" "$src" "$out/vconcurrent"
printf '\n/install.log\n/run.log\n' >> "$(git rev-parse --git-path info/exclude)"
node "$stage/python-runner/sequential-overlay.mjs" "$PWD" "$src"
git diff --check
git diff --binary > "$pack/sequential-overlay.diff"
corepack pnpm run build
corepack pnpm pack --pack-destination "$pack"
mapfile -t tarballs < <(find "$pack" -maxdepth 1 -type f -name '*.tgz')
test "${#tarballs[@]}" = 1
sha256sum "${tarballs[0]}" | tee "$pack/pack.sha256"
date -u +%FT%TZ > "$pack/packed-at.utc"
read -r sequential _ < "$pack/pack.sha256"
node "$stage/stage.mjs" "${tarballs[0]}" "$sequential" "$src" "$out/vsequential"
cp "$out/vconcurrent"/tracecode-harness-*.tgz "$out/vconcurrent/candidate.tgz"
ln -s vconcurrent "$out/vcandidate"
ln -s vconcurrent "$out/vconcurrent-deploy"
for version in 0.17.1 0.20.1; do
  ln -s "../historical/v$version" "$out/v$version"
done
node --input-type=module - "$stage" "$out" "$pack" <<'JS'
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
const [stage, out, pack] = process.argv.slice(2);
const load = (name) => JSON.parse(readFileSync(join(out, name, 'candidate.json')));
const concurrent = load('vconcurrent');
const sequential = load('vsequential');
sequential.packedAt = readFileSync(join(pack, 'packed-at.utc'), 'utf8').trim();
sequential.overlayDiffSha256 = createHash('sha256')
  .update(readFileSync(join(pack, 'sequential-overlay.diff'))).digest('hex');
const manifest = { concurrent, 'concurrent-deploy': concurrent, sequential };
writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
for (const row of Object.values(manifest)) {
  if (row.commit !== '3dfc7dc13de0c8d9cfc325197d10dff8a16051cb') process.exit(2);
}
console.log(JSON.stringify(manifest));
JS
ln -sfn python-3dfc7dc1 "$stage/python"
test "$(readlink -f "$stage/python")" = "$(readlink -f "$out")"
