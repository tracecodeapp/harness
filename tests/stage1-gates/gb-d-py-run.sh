#!/usr/bin/env bash
# Run after the coordinator grants an ordinary AgentRunner slot and supplies a carried pin.
set -euo pipefail

step() {
  local name=$1 code=0
  shift
  "$@" || code=$?
  printf 'STEP %s exit=%s\n' "$name" "$code" >&2
  if [[ ${status_log:-} ]]; then
    printf '%s\t%s\n' "$name" "$code" >> "$status_log"
  fi
  return "$code"
}

verify_pin() {
  local recorded filename
  read -r recorded filename < "$tarball.sha256" || return
  [[ $recorded == "$pin" && $filename == "${tarball##*/}" ]] || return 2
  printf '%s  %s\n' "$pin" "$tarball" | sha256sum --check -
}

unpack_mux() {
  mkdir gate-mux || return
  printf '%s' "$mux" | base64 -d | tar -xzf - -C gate-mux || return
  test "$(cat gate-mux/mux.sha)" = 82888fb7bc95272e43477ab5ae62b95cc28e9008
}

if [[ ${1:-} == --on-host ]]; then
  shift
  subject=$1 tarball=$2 pin=$3 mux=$4
  status_log=gb-py-steps.tsv
  printf 'step\texit\n' > "$status_log"
  step verify-pin verify_pin
  step pinned-mux unpack_mux
  controls=0 gate=0
  step seeded-controls node --test tests/stage1-gates/gb-controls.test.mjs || controls=$?
  step installed-python-g4-g5 env CI=1 GB_LANGUAGES=python TRACECODE_STAGE1_MUX_INPUT="$PWD/gate-mux" \
    TRACECODE_STAGE1_SUBJECT="$subject" TRACECODE_STAGE1_SUBJECT_TARBALL="$tarball" \
    TRACECODE_STAGE1_SUBJECT_SHA256="$pin" bash tests/stage1-gates/gb-pack.sh d-py || gate=$?
  if (( controls != 0 )); then exit "$controls"; fi
  exit "$gate"
fi

if [[ $# != 4 ]]; then
  printf '%s\n' 'Usage: gb-d-py-run.sh SUBJECT HOST_TARBALL SHA256 OUTPUT_DIR' >&2
  exit 2
fi
subject=$1 tarball=$2 pin=$3 output=$4
[[ $subject =~ ^[0-9a-f]{40}$ && $pin =~ ^[0-9a-f]{64}$ &&
   $tarball =~ ^/root/ci/(coord-artifacts/|d-py-final-[A-Za-z0-9._-]+/pin/)[A-Za-z0-9._-]+\.tgz$ ]] || exit 2
repo=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
tool="$HOME/Code/tracecodeapp/harness-artifacts/tools/ar-harness.sh"
mux_repo="$HOME/Code/tracecodeapp/multiplexer"
[[ -z $(git -C "$repo" status --porcelain) ]] || exit 2
step evidence-output mkdir -p "$output"
exec > >(tee "$output/launch.log") 2>&1
suffix="gb-d-py-${subject:0:8}-$(date -u +%Y%m%dT%H%M%SZ)"
mux_directory=$(mktemp -d /tmp/gb-d-py-mux.XXXXXX)
trap 'rm -f "$mux_directory"/{judge-browser-slot.ts,project-wire.ts,mux.sha}; rmdir "$mux_directory"' EXIT

encode_mux() {
  mux=$(tar -czf - -C "$mux_directory" judge-browser-slot.ts project-wire.ts mux.sha | base64 | tr -d '\n')
}
step stage-mux bash "$repo/tests/stage1-gates/stage-mux.sh" "$mux_repo" "$mux_directory"
step encode-mux encode_mux

collect_evidence() {
  ssh -o BatchMode=yes agentrunner bash -s -- "/root/ci/work-harness-$suffix" <<'HOST' | tar -xf - -C "$output"
set -e
cd "$1"
set --
for file in install.log run.log gb-py-steps.tsv gate-evidence/d-py/{candidate,runner,tarball,installed-judge}.sha* \
            gate-evidence/d-py/{raw.ndjson,gb-*.json}; do
  if [[ -f $file ]]; then set -- "$@" "$file"; fi
done
test "$#" -gt 0
tar -cf - -- "$@"
HOST
}

job=0 transfer=0 cleanup=0
step shared-slot env GIT_SSH_COMMAND='ssh -o BatchMode=yes' \
  bash "$tool" "$repo" "$suffix" bash tests/stage1-gates/gb-d-py-run.sh \
  --on-host "$subject" "$tarball" "$pin" "$mux" || job=$?
if (( job == 255 || job == 3 )); then exit "$job"; fi
step collect-evidence collect_evidence || transfer=$?
step clean-host-job bash "$tool" "$repo" "$suffix" --cleanup || cleanup=$?
for code in "$cleanup" "$transfer" "$job"; do
  if (( code != 0 )); then exit "$code"; fi
done
