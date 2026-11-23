#!/usr/bin/env bash
set -euo pipefail
source_receipt=$1
output=$2
head=$(node -p 'require(process.argv[1]).head' "$source_receipt/pack.json")
[[ "$head" =~ ^[0-9a-f]{40}$ ]]
digest=$(cat "$source_receipt/qualified.sha256")
file=$(node -p 'require(process.argv[1]).file' "$source_receipt/pack.json")
node scripts/stage1/clean-pack.mjs --verify "$source_receipt/$file" "$digest"

temp=$(mktemp -d)
trap 'rm -rf "$temp"' EXIT
worker=workers/javascript/javascript-project-worker.js
git show "$head:$worker" >"$temp/original.js"
python3 - "$temp/original.js" "$temp/stale.js" <<'PY'
from pathlib import Path
import re
import sys
original, mutant = map(Path, sys.argv[1:])
text, hits = re.subn(
    rb'^var TRACECODE_HARNESS_VERSION = "[^"]+";$',
    b'var TRACECODE_HARNESS_VERSION = "0.0.0-stage1-stale";',
    original.read_bytes(),
    flags=re.MULTILINE,
)
assert hits == 1, hits
mutant.write_bytes(text)
PY
blob=$(git hash-object -w "$temp/stale.js")
(
  export GIT_INDEX_FILE="$temp/index"
  git read-tree "$head"
  mode=$(git ls-tree "$head" "$worker" | awk '{print $1}')
  git update-index --cacheinfo "$mode,$blob,$worker"
  git write-tree
) >"$temp/tree"
mutant=$(
  git -c user.name="Harness Stage 1" -c user.email="stage1@tracecode.app" commit-tree \
    "$(cat "$temp/tree")" -p "$head" -m "Seed stale generated project worker for G7"
)
test "$(git diff --name-only "$head" "$mutant")" = "$worker"
if node scripts/stage1/clean-pack.mjs "$mutant" "$output" >"$output.log" 2>&1; then
  echo 'G7/stale-worker-control: mutant passed'
  exit 1
fi
grep -F 'G7/build/tree-dirty' "$output.log"
test "$(cat "$output/build.status")" = " M $worker"
echo "G7/stale-worker-control: build/tree-dirty hit=1 on $mutant"
node scripts/stage1/clean-pack.mjs --verify "$source_receipt/$file" "$digest"
