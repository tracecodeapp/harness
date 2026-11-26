#!/usr/bin/env bash
set -euo pipefail
source_checkout="${1:?Expected the runner checkout with installed dependencies}"
stage="$(cd "$(dirname "$0")" && pwd)"
out="$stage/final-release"
dest="$stage/node_modules"
tmp="$stage/.final-release-node-modules.$$"
created_dest=0

test -d "$source_checkout/.git" -a -d "$source_checkout/node_modules"
test -r "$source_checkout/package.json" -a -r "$source_checkout/pnpm-lock.yaml"
test -d "$out" -a ! -e "$dest" -a ! -L "$dest" -a ! -e "$tmp"
runner_commit="$(git -C "$source_checkout" rev-parse HEAD)"
[[ "$runner_commit" =~ ^[0-9a-f]{40}$ ]]

cleanup() {
  case "$tmp" in "$stage"/.final-release-node-modules.*) rm -rf -- "$tmp" ;; *) return 2 ;; esac
  if ((created_dest == 1)); then
    case "$dest" in "$stage"/node_modules) rm -rf -- "$dest" ;; *) return 2 ;; esac
  fi
}
trap cleanup EXIT
esbuild="$(realpath "$source_checkout/node_modules/esbuild")"
playwright="$(realpath "$source_checkout/node_modules/playwright")"
esbuild_linux="$(realpath "$(dirname "$esbuild")/@esbuild/linux-x64")"
playwright_core="$(realpath "$(dirname "$playwright")/playwright-core")"
mkdir -p "$tmp/@esbuild"
cp -aL --reflink=auto "$esbuild" "$tmp/esbuild"
cp -aL --reflink=auto "$esbuild_linux" "$tmp/@esbuild/linux-x64"
cp -aL --reflink=auto "$playwright" "$tmp/playwright"
cp -aL --reflink=auto "$playwright_core" "$tmp/playwright-core"
mv "$tmp" "$dest"
created_dest=1
test -d "$dest" -a ! -L "$dest"

while IFS= read -r -d '' link; do
  resolved="$(realpath "$link")"
  case "$resolved" in "$dest"/*) ;; *) echo "Runner dependency escapes stage: $link -> $resolved" >&2; exit 2 ;; esac
done < <(find "$dest" -type l -print0)

cd "$stage"
node --input-type=module -e \
  'await import("esbuild"); await import("playwright"); console.log("runner dependency imports: OK")'
package_sha="$(sha256sum "$source_checkout/package.json" | awk '{print $1}')"
lock_sha="$(sha256sum "$source_checkout/pnpm-lock.yaml" | awk '{print $1}')"
node --input-type=module - "$out/runner-dependencies.json" "$runner_commit" \
    "$package_sha" "$lock_sha" <<'JS'
import { writeFileSync } from 'node:fs';
const [path, runnerCommit, packageJsonSha256, pnpmLockSha256] = process.argv.slice(2);
const esbuild = await import('esbuild');
const playwright = await import('playwright');
writeFileSync(path, JSON.stringify({
  schema: 'tracecode.g8-runner-dependencies.v1',
  runnerCommit,
  packageJsonSha256,
  pnpmLockSha256,
  imports: {
    esbuild: typeof esbuild.build === 'function',
    playwright: typeof playwright.chromium?.launch === 'function',
  },
  selfContainedPath: 'node_modules',
}, null, 2) + '\n');
JS
trap - EXIT
echo "runner_dependencies=$dest runner_commit=$runner_commit"
