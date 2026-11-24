#!/usr/bin/env bash
# Run once inside an ordinary AgentRunner slot. The local source repo contains
# the gate commit and both companion source commits. No Git remote is written.
set -euo pipefail
export CI=1 GIT_TERMINAL_PROMPT=0
export TRACECODE_STAGE1_RECEIPT_LANGUAGES=cpp

if [[ $# != 5 ]]; then
  echo "Usage: $0 SOURCE_REPO GATE_COMMIT APP_MANIFEST MUX_INPUT NEW_JOB_DIRECTORY" >&2
  exit 2
fi
source_repo=$(realpath "$1")
gate_commit=$2
app_manifest=$(realpath "$3")
mux_input=$(realpath "$4")
job_root=$5
artifact_root=/root/ci/coord-artifacts
step7=9b30ad9bc203ad2ba2f159d96dfaef62940262c7
c_cpp=46943f54e42abcd5c008ac88261446a89a3fd270
step7_tarball="$artifact_root/feat-b7-cpp-9b30ad9bc203.tgz"
c_cpp_tarball="$artifact_root/c-cpp-46943f54.tgz"
step7_pin=562612f2b8e9240181890a0d2a3493277d725dcc9d68546fcca40e664a5300b6
c_cpp_pin=75c96699765bc637221d47d7f0d712eb61b68f5e07ac04705d1ff67b0f2c453a
app_pin=52d79823668e5326018986bc887b58422407a48731cf0966b09e44b98e03a62f

verify_pin() {
  local tarball=$1 expected=$2
  [[ "$(awk 'NR == 1 {print $1}' "$tarball.sha256")" == "$expected" ]] || {
    echo "Adjacent pin mismatch for $tarball" >&2
    exit 2
  }
  printf '%s  %s\n' "$expected" "$tarball" | sha256sum --check
}
verify_pin "$step7_tarball" "$step7_pin"
verify_pin "$c_cpp_tarball" "$c_cpp_pin"
printf '%s  %s\n' "$app_pin" "$app_manifest" | sha256sum --check
test -r "$mux_input/mux.sha"
test -r "$mux_input/judge-browser-slot.ts"
for commit in "$gate_commit" "$step7" "$c_cpp"; do
  [[ "$commit" =~ ^[0-9a-f]{40}$ ]]
  git -C "$source_repo" cat-file -e "$commit^{commit}"
done
export TRACECODE_STAGE1_COMPANION_REPO="$source_repo"

mkdir "$job_root"
job_root=$(realpath "$job_root")

run_pin() (
  local name=$1 subject=$2 tarball=$3 sha=$4
  local work="$job_root/$name"
  local result=0
  git clone --quiet --no-checkout "$source_repo" "$work" || return 2
  git -C "$work" checkout --quiet --detach "$gate_commit" || return 2
  cd "$work" || return 2
  [[ "$(git rev-parse HEAD)" == "$gate_commit" ]] || return 2
  corepack pnpm install --frozen-lockfile --prefer-offline >"$job_root/$name-runner-install.log" 2>&1 || {
    tail -40 "$job_root/$name-runner-install.log"
    return 2
  }
  export TRACECODE_STAGE1_SUBJECT="$subject"
  export TRACECODE_STAGE1_SUBJECT_TARBALL="$tarball"
  export TRACECODE_STAGE1_SUBJECT_SHA256="$sha"
  bash tests/stage1-gates/agent-runner.sh "$name" '^G[16]/cpp/' "$app_manifest" "$mux_input" >"$job_root/$name.log" 2>&1 || result=$?
  printf '%s\n' "$result" >"$job_root/$name.exit"
  test -s "gate-evidence/$name/summary.json" || {
    tail -40 "$job_root/$name.log"
    return 2
  }
  printf '%s\n' "$work/gate-evidence/$name/summary.json"
)
job_status=0
run_pin cpp-step7 "$step7" "$step7_tarball" "$step7_pin" || job_status=2
run_pin c-cpp "$c_cpp" "$c_cpp_tarball" "$c_cpp_pin" || job_status=2
exit "$job_status"
