#!/usr/bin/env bash
set -euo pipefail

stage="$(cd "$(dirname "$0")" && pwd)"
art=/root/ci/coord-artifacts
out="$stage/python-experiments"
test ! -e "$out"
mkdir -p "$out"

stage_one() {
  local label="$1" archive="$2" expected="$3" commit="$4"
  (cd "$art" && printf '%s  %s\n' "$expected" "$archive" | sha256sum --strict -c -)
  node "$stage/stage.mjs" "$art/$archive" "$expected" "$commit" "$out/v$label"
}

stage_one concurrent-e1 e1-python-snapshot-bece725f.tgz \
  d65ab15ec2d077cf069ccf9cc63f2997acc4b40c4c47df9932d13660b62ca9d8 \
  c88ea88fbcf05d8c20c8fa29910527c2e1b8e1a8
stage_one sequential e2-python-bece-sequential.tgz \
  e643a62eeaa92642380ee984a7bab8c61260f619231c220745f139c8feb07a2e \
  9a34ea8c743d1b9f88cb52de8a6f83f6536e8b5d
stage_one sequential-f1 f1-python-drawing-sequential-efd78c7987ae.tgz \
  b189c44ca7a0bbfba15645a99a2e00e7f2d3d66a6cc535c6ebf297fc1f55a356 \
  e7dde9f2209eb76b652333c19b57560808850bda
stage_one sequential-f1-d1 e2-python-f1-d1-sequential-efd78c79.tgz \
  02f14291d822cb3d9110f90439b029ea0eb4a43359e35b2d40161e4db5215244 \
  c545e0b49e69588e23637b1796a933e7f7f62f9f
stage_one concurrent-base e2-python-bece-concurrent.tgz \
  fce0673b235ff82f592db35d702af0385989b61d4d4badce28626f42d5581e5c \
  bece725fe3793a925330a8a417569f18a8dbab2e
stage_one concurrent-f1-d1 e2-python-f1-d1-concurrent-efd78c79.tgz \
  0c57a4eb36f83a99ff59f6b84d9eb209aa54b3c996dd08555e7607da2a008d29 \
  26d8d99b85f3c920eddd1955d33f395966223153

for version in 0.17.1 0.20.1; do
  ln -s "../historical/v$version" "$out/v$version"
done

node --input-type=module - "$out" <<'JS'
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const [out] = process.argv.slice(2);
const labels = [
  'concurrent-e1',
  'sequential',
  'sequential-f1',
  'sequential-f1-d1',
  'concurrent-base',
  'concurrent-f1-d1',
];
const manifest = Object.fromEntries(labels.map((label) => [
  label,
  JSON.parse(readFileSync(join(out, 'v' + label, 'candidate.json'))),
]));
writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify(manifest));
JS

echo "staged=$out"
