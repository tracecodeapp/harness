#!/usr/bin/env bash
set -uo pipefail
case "${1:?Expected java, csharp or python}" in java|csharp|python) language="$1" ;; *) exit 2 ;; esac
max_minutes="${2:?Expected total window minutes}"
[[ "$max_minutes" =~ ^[1-9][0-9]*$ ]] || exit 2
stage="$(cd "$(dirname "$0")" && pwd)"
baseline="$stage/frozen-baseline"
out="$stage/$language"

(cd "$stage" && sha256sum --strict -c runner.sha256) || exit 2
(cd "$baseline" && sha256sum --strict -c "$stage/baseline-results.sha256") || exit 2

session_status=0
/root/ci/bin/heavy-exclusive env SPEED_EXCLUSIVE_WINDOW=1 \
  bash "$stage/session.sh" "$language" "$max_minutes" || session_status=$?

score_status=0
node "$stage/score.mjs" "$baseline" "$out" "$language" > "$out/score.log" 2>&1 || score_status=$?
tail -40 "$out/score.log"
echo "session_status=$session_status score_status=$score_status"
((session_status == 0 && score_status == 0))
