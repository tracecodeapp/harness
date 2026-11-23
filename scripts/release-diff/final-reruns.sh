#!/bin/bash
# Final-run follow-ups in one host job: rerun the differing problems once alone (both versions
# and the target without stopAtFirstRunaway), then the C# U4 sequence five times alone.
# Expects final-rerun.txt (from rerun_list.py) in the checkout root; reuses the built target.
set -uo pipefail
status=0
if [ -s final-rerun.txt ]; then
  RD_RERUN_FILE=final-rerun.txt RD_OUT=rerun-out RD_NOSTOP_SIDE=1 RD_SKIP_BUILD=1 \
    bash scripts/release-diff/host-job.sh || status=1
fi
mkdir -p u4-out
for i in 1 2 3 4 5; do echo "csharp signed-routing-audit,task-dependency-order"; done >u4-out/rerun-list.txt
RD_RERUN_FILE=u4-out/rerun-list.txt RD_OUT=u4-out RD_SIDES="target target-nostop" RD_SKIP_BUILD=1 \
  bash scripts/release-diff/host-job.sh || status=1
exit $status
