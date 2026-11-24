#!/usr/bin/env bash
# Run validate.sh as one agentrunner job, in a slot the coordinator assigns.
# Usage: AR_HARNESS=<path to harness-artifacts/tools/ar-harness.sh> \
#          bash scripts/c-cpp-lane-validation/launch-from-laptop.sh APP_STAGE_MANIFEST
#   APP_STAGE_MANIFEST: GA's app-shaped fixture manifest, sha256 52d79823… (app commit 6783a3d2).
# Stages the gate, step-7 and cap commits and the manifest on the host, runs the job
# through harness-artifacts/tools/ar-harness.sh (heavy limiter, nice, ionice), copies the
# evidence back, and removes every host directory and job branch it created.
set -euo pipefail
manifest=${1:?APP_STAGE_MANIFEST}
ar=${AR_HARNESS:?AR_HARNESS must name harness-artifacts/tools/ar-harness.sh}
root=$(git rev-parse --show-toplevel)
cd "$root"
head=$(git rev-parse HEAD)
host_dir=/root/ci/c-cpp-validate
local_out=${C_CPP_LOCAL_OUT:-$root/../c-cpp-validate-out}
bare=ssh://agentrunner/root/ci/harness.git
ssh -o BatchMode=yes agentrunner "test ! -e $host_dir && mkdir -p $host_dir"
scp -q "$manifest" "agentrunner:$host_dir/app-stage-manifest.json"
git push -q -f "$bare" \
  6c5c8768a007c64241b5ef85bb3fd1d5ad2fd3c0:refs/heads/job-c-cpp-validate-ga-gate \
  a6c1485d9d165fe99861bc1028edc737d539edf5:refs/heads/job-c-cpp-validate-gb-gate \
  9b30ad9bc203ad2ba2f159d96dfaef62940262c7:refs/heads/job-c-cpp-validate-step7 \
  e2c660d3:refs/heads/job-c-cpp-validate-cap-source
set +e
bash "$ar" "$root" c-cpp-validate \
  env C_CPP_EXPECTED_HEAD="$head" nice -n 10 ionice -c3 \
  bash scripts/c-cpp-lane-validation/validate.sh $host_dir/out $host_dir/app-stage-manifest.json \
  /root/ci/ga-021-input.DJzR9ze6/mux
code=$?
set -e
mkdir -p "$local_out"
ssh -o BatchMode=yes agentrunner "cd $host_dir/out && tar czf - steps.txt resources.txt head.txt lock-*.sha logs evidence pin/pin.sha256 compare.json 2>/dev/null" \
  | tar xzf - -C "$local_out"
bash "$ar" "$root" c-cpp-validate --cleanup
ssh -o BatchMode=yes agentrunner "rm -rf $host_dir; for b in ga-gate gb-gate step7 cap-source scope1 cap; do git -C /root/ci/harness.git branch -D job-c-cpp-validate-\$b >/dev/null 2>&1; done; ps -eo pid,cmd | grep -E 'c-cpp-validate|validate.sh' | grep -v grep || true"
echo "job exit=$code; evidence in $local_out"
exit "$code"
