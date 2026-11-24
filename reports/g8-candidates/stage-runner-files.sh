#!/usr/bin/env bash
set -euo pipefail
source_dir="$(cd "${1:?Expected runner source directory}" && pwd)"
target_dir="${2:?Expected runner target directory}"
receipt="$source_dir/runner.sha256"
test -r "$receipt" -a -d "$target_dir"

while read -r _ file; do
  test -r "$source_dir/$file"
  mkdir -p "$target_dir/$(dirname "$file")"
  cp -p "$source_dir/$file" "$target_dir/$file"
done < "$receipt"
cp -p "$receipt" "$target_dir/runner.sha256"
(cd "$target_dir" && sha256sum --strict -c runner.sha256)
