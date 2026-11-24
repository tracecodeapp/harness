#!/usr/bin/env bash
set -euo pipefail
case "${1:?Expected java, csharp or python}" in
  java|csharp|python) language="$1" ;;
  *) exit 2 ;;
esac
stage="$(cd "$(dirname "$0")" && pwd)"
control="$stage/historical/v0.17.1"
out="$stage/$language"
expected=e3373fa0b3e1bd6e5c167f536051a51e28344fe4e31130cc4b1c46a3a44c7df3
test -r "$control/candidate.json" -a -d "$out"
printf '%s  %s\n' "$expected" "$control/tracecode-harness-0.17.1.tgz" | sha256sum --strict -c -
ln -sfn ../historical/v0.17.1 "$out/v0.17.1"
test "$(readlink -f "$out/v0.17.1")" = "$(readlink -f "$control")"
if [[ "$language" == python ]]; then
  submit_control="$stage/historical/v0.20.1"
  submit_expected=e0a4c4d47b4880a49040329112fc779500b3dbeed039934873b72585eaedaf13
  test -r "$submit_control/candidate.json"
  printf '%s  %s\n' "$submit_expected" "$submit_control/tracecode-harness-0.20.1.tgz" |
    sha256sum --strict -c -
  ln -sfn ../historical/v0.20.1 "$out/v0.20.1"
  test "$(readlink -f "$out/v0.20.1")" = "$(readlink -f "$submit_control")"
fi
