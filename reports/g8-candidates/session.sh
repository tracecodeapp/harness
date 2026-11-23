#!/usr/bin/env bash
set -euo pipefail
case "${1:?Expected java, csharp or python}" in java|csharp|python) language="$1" ;; *) exit 2 ;; esac
max_minutes="${2:?Expected total window minutes}"
[[ "$max_minutes" =~ ^[1-9][0-9]*$ && "${SPEED_EXCLUSIVE_WINDOW:-}" == 1 ]] || exit 2
stage="$(cd "$(dirname "$0")" && pwd)"
cd "$stage"
sha256sum -c runner.sha256
case "$(node --version)" in v22.*) ;; *) exit 2 ;; esac
job_source="$(git -C "$OLDPWD" rev-parse HEAD)"
[[ "$job_source" =~ ^[0-9a-f]{40}$ ]] || exit 2
echo "runner_source=$job_source"
ln -sfn "$OLDPWD/node_modules" "$stage/node_modules"
# The runner looks up the owning harness clone for its supplemental git receipt.
# The independently hashed source inventory identifies the runner source itself.
export GIT_DIR="$OLDPWD/.git"
deadline=$((SECONDS + max_minutes * 60))
result=0
out="$stage/$language"
if [[ "$language" == python ]]; then
  test -r "$out/manifest.json" && test -r "$out/vsequential/candidate.json" &&
    test -r "$out/vconcurrent/candidate.json" || exit 2
else
  test -r "$out/vcandidate/candidate.json" || exit 2
fi
run_scope() {
  local label="$1" status=0
  shift
  local left=$((deadline - SECONDS))
  if ((left <= 0)); then
    echo "Window elapsed before $language $label"
    result=1
    return
  fi
  "$@" "$((left / 60)).$(printf '%02d' "$((left % 60 * 100 / 60))")" > "$out/$label.log" 2>&1 || status=$?
  tail -8 "$out/$label.log"
  if rg -qi 'sample.*(login|sign in|unauthoriz|access denied)|Error:.*(login|sign in|unauthoriz|access denied)' "$out/$label.log"; then
    echo "Authentication refusal in $language $label"
    exit 1
  fi
  if ((status != 0)); then result=1; fi
}
java_style_scope() {
  local scope="$1" window="$2"
  run_scope "$scope" env SPEED_G8_LANGUAGE="$language" SPEED_JAVA_SCOPE="$scope" \
    node java-runner/run-g8.mjs "$out" run "$window" 212026
}
if [[ "$language" == python ]]; then
  run_scope phone node python-runner/run-g8.mjs baseline "$out" phone "$out/manifest.json" 212026
  run_scope desktop node python-runner/run-g8.mjs baseline "$out" desktop-b "$out/manifest.json" 212026
else
  java_style_scope desktop desktop-a
  java_style_scope phone phone
fi
java_style_scope spot desktop-a
exit "$result"
