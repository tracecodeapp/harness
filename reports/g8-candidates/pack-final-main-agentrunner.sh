#!/usr/bin/env bash
set -euo pipefail
expected="${1:?Expected exact final-main commit}"
archive="${2:?Expected registered archive basename}"
[[ "$expected" =~ ^[0-9a-f]{40}$ && "$archive" =~ ^[0-9A-Za-z._-]+[.]tgz$ ]] || exit 2
test "$(git rev-parse HEAD)" = "$expected"
test -z "$(git status --porcelain)"

art=/root/ci/coord-artifacts
test ! -e "$art/$archive" -a ! -e "$art/$archive.sha256"
tmp="$(mktemp -d /root/ci/g8-final-pack.XXXXXX)"
cleanup() {
  case "$tmp" in /root/ci/g8-final-pack.*) rm -rf -- "$tmp" ;; *) exit 2 ;; esac
}
trap cleanup EXIT

nice -n 19 ionice -c 3 corepack pnpm run build
test -z "$(git status --porcelain)"
nice -n 19 ionice -c 3 corepack pnpm pack --pack-destination "$tmp"
mapfile -t packs < <(find "$tmp" -maxdepth 1 -type f -name '*.tgz')
test "${#packs[@]}" = 1
install -m 0444 "${packs[0]}" "$art/$archive"
(cd "$art" && sha256sum "$archive" > "$archive.sha256" && chmod 0444 "$archive.sha256")
(cd "$art" && sha256sum --strict -c "$archive.sha256")
printf 'source=%s\nartifact=%s\n' "$expected" "$art/$archive"
