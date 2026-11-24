#!/usr/bin/env bash
set -euo pipefail
stage="$(cd "$(dirname "$0")" && pwd)"
cd "$stage"
case "$(node --version)" in v22.*) ;; *) exit 2 ;; esac

art=/root/ci/coord-artifacts
name=b5-java-switched-registered-be2f3d79702c
archive="$art/$name.tgz"
sidecar="$archive.sha256"
expected=17e43a8e0d0d78ac074ef61da0661c1001f2caa9264b3b0e44d98ec4e5605ad1
head=be2f3d79702cd11c54c0a3208da0a0188a4779ef
target="$stage/java-be2f3d79"

[[ -r "$archive" && -r "$sidecar" ]] || exit 2
(cd "$art" && sha256sum --strict -c "$(basename "$sidecar")")
printf '%s  %s\n' "$expected" "$archive" | sha256sum --strict -c -

if [[ ! -e "$target" ]]; then
  mkdir -p "$target"
  node "$stage/stage.mjs" "$archive" "$expected" "$head" "$target/vcandidate"
  cp "$target"/vcandidate/tracecode-harness-*.tgz "$target/vcandidate/candidate.tgz"
fi

node --input-type=module - "$target/vcandidate/candidate.json" "$head" "$expected" <<'JS'
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const [receiptPath, head, expected] = process.argv.slice(2);
const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
assert.equal(receipt.commit, head);
assert.equal(receipt.tarballSha256, expected);
JS
printf '%s  %s\n' "$expected" "$target/vcandidate/candidate.tgz" | sha256sum --strict -c -

ln -sfn "$(basename "$target")" "$stage/java"
test "$(readlink -f "$stage/java")" = "$(readlink -f "$target")"
cat "$target/vcandidate/candidate.json"
