#!/usr/bin/env bash
set -euo pipefail
max_minutes="${1:?Expected total window minutes}"
[[ "$max_minutes" =~ ^[1-9][0-9]*$ && "${SPEED_EXCLUSIVE_WINDOW:-}" == 1 ]] || exit 2
stage="$(cd "$(dirname "$0")" && pwd)"
cd "$stage"
sha256sum -c runner.sha256
case "$(node --version)" in v22.*) ;; *) exit 2 ;; esac
source_dir="${SPEED_JOB_SOURCE_DIR:?Expected SPEED_JOB_SOURCE_DIR}"
job_source="$(git -C "$source_dir" rev-parse HEAD)"
[[ "$job_source" =~ ^[0-9a-f]{40}$ ]] || exit 2
echo "runner_source=$job_source"
ln -sfn "$source_dir/node_modules" "$stage/node_modules"
export GIT_DIR="$source_dir/.git"
out="$stage/release-aa-closing"
test -r "$out/vrelease/candidate.json" -a -r "$out/v0.17.1/candidate.json" || exit 2
status=0
env SPEED_G8_AA_CLOSING=1 SPEED_G8_RELEASE=0.17.3 SPEED_G8_LANGUAGE=csharp SPEED_JAVA_SCOPE=desktop \
  node java-runner/run-g8.mjs "$out" run desktop-a 212026 "$max_minutes" \
  > "$out/control.log" 2>&1 || status=$?
tail -8 "$out/control.log"
if rg -qi 'sample.*(login|sign in|unauthoriz|access denied)|Error:.*(login|sign in|unauthoriz|access denied)' "$out/control.log"; then
  echo "Authentication refusal in closing A/A control"
  exit 1
fi
exit "$status"
