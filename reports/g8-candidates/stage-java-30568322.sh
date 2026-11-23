#!/usr/bin/env bash
set -euo pipefail
stage="$(cd "$(dirname "$0")" && pwd)"
cd "$stage"
case "$(node --version)" in v22.*) ;; *) exit 2 ;; esac

art=/root/ci/coord-artifacts
name=b5-java-journal-registered-30568322
archive="$art/$name.tgz"
sidecar="$archive.sha256"
expected=8f095ae3449e5e94575065b0d02345a9e57aebfd6acb7597b634a37464fb9bd6
head=305683221863a4e719d88c9a25d5fdb39e022109
target="$stage/java-30568322"

[[ -r "$archive" && -r "$sidecar" ]] || exit 2
(cd "$art" && sha256sum --strict -c "$(basename "$sidecar")")
printf '%s  %s\n' "$expected" "$archive" | sha256sum --strict -c -

if [[ ! -e "$target" ]]; then
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
