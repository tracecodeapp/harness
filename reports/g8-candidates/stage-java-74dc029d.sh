#!/usr/bin/env bash
set -euo pipefail
stage="$(cd "$(dirname "$0")" && pwd)"
cd "$stage"
case "$(node --version)" in v22.*) ;; *) exit 2 ;; esac

art=/root/ci/coord-artifacts
name=b5-java-admission-registered-74dc029d4bc4
archive="$art/$name.tgz"
sidecar="$archive.sha256"
expected=86e63eee612334f471d664940e07d864c23bd89e1ae75f6bf5e81eeb90e77e71
head=74dc029d4bc47682e9279a03bf500bc3cd5095d2
target="$stage/java-74dc029d"

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

if [[ -e "$stage/java" && ! -L "$stage/java" ]]; then
  previous="$(node --input-type=module - "$stage/java/vcandidate/candidate.json" <<'JS'
import { readFile } from 'node:fs/promises';
const receipt = JSON.parse(await readFile(process.argv[2], 'utf8'));
if (!/^[0-9a-f]{40}$/.test(receipt.commit)) process.exit(2);
process.stdout.write('java-' + receipt.commit.slice(0, 8));
JS
)"
  [[ ! -e "$stage/$previous" ]] || exit 2
  mv "$stage/java" "$stage/$previous"
fi
ln -sfn "$(basename "$target")" "$stage/java"
test "$(readlink -f "$stage/java")" = "$(readlink -f "$target")"
cat "$target/vcandidate/candidate.json"
