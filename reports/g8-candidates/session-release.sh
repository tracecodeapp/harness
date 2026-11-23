#!/usr/bin/env bash
set -euo pipefail
max_minutes="${1:?Expected total window minutes}"
[[ "$max_minutes" =~ ^[1-9][0-9]*$ && "${SPEED_EXCLUSIVE_WINDOW:-}" == 1 ]] || exit 2
stage="$(cd "$(dirname "$0")" && pwd)"
cd "$stage"
sha256sum -c runner.sha256
case "$(node --version)" in v22.*) ;; *) exit 2 ;; esac
job_source="$(git -C "$OLDPWD" rev-parse HEAD)"
[[ "$job_source" =~ ^[0-9a-f]{40}$ ]] || exit 2
echo "runner_source=$job_source"
ln -sfn "$OLDPWD/node_modules" "$stage/node_modules"
export GIT_DIR="$OLDPWD/.git"
deadline=$((SECONDS + max_minutes * 60))
out="$stage/release-0.17.3"
test -r "$out/vrelease/candidate.json" || exit 2
result=0

run_scope() {
  local label="$1" language="$2" scope="$3" window="$4" status=0
  local left=$((deadline - SECONDS))
  if ((left <= 0)); then
    echo "Window elapsed before 0.17.3 $label"
    result=1
    return
  fi
  env SPEED_G8_RELEASE=0.17.3 SPEED_G8_LANGUAGE="$language" SPEED_JAVA_SCOPE="$scope" \
    node java-runner/run-g8.mjs "$out" run "$window" 212026 \
    "$((left / 60)).$(printf '%02d' "$((left % 60 * 100 / 60))")" > "$out/$label.log" 2>&1 || status=$?
  tail -8 "$out/$label.log"
  if rg -qi 'sample.*(login|sign in|unauthoriz|access denied)|Error:.*(login|sign in|unauthoriz|access denied)' "$out/$label.log"; then
    echo "Authentication refusal in 0.17.3 $label"
    exit 1
  fi
  if ((status != 0)); then result=1; fi
}

run_scope spot csharp spot desktop-a
run_scope csharp-desktop csharp desktop desktop-a
run_scope csharp-phone csharp phone phone
run_scope python-desktop python desktop desktop-a
run_scope python-phone python phone phone
exit "$result"
