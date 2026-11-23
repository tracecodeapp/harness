#!/usr/bin/env bash
set -euo pipefail
receipt=$1
digest=$(cat "$receipt/qualified.sha256")
tarball=$(find "$receipt" -maxdepth 1 -name '*.tgz' -type f)
node scripts/stage1/clean-pack.mjs --verify "$tarball" "$digest"
fault=$(mktemp)
trap 'rm -f "$fault"' EXIT
cp "$tarball" "$fault"
python3 - "$fault" <<'PY'
import sys
with open(sys.argv[1], "r+b") as tarball:
    tarball.seek(100)
    before = tarball.read(1)
    assert len(before) == 1
    tarball.seek(100)
    tarball.write(bytes([before[0] ^ 1]))
PY
if red=$(node scripts/stage1/clean-pack.mjs --verify "$fault" "$digest" 2>&1); then
  echo "G7/control: packed-byte mutant survived"
  exit 1
fi
case "$red" in
  G7/pack/digest:*) echo "G7/control: packed-byte mutant hit=1: $red";;
  *) echo "$red"; exit 1;;
esac
