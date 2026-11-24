#!/usr/bin/env bash
set -euo pipefail
stage="$(cd "$(dirname "$0")" && pwd)"
cd "$stage"
bash stage-aa.sh
mkdir -p release-aa-closing
ln -sfn ../release-0.17.3/vrelease release-aa-closing/vrelease
ln -sfn ../historical/v0.17.1 release-aa-closing/v0.17.1
ln -sfn ../historical/v0.20.1 release-aa-closing/v0.20.1
test "$(readlink -f release-aa-closing/vrelease)" = "$(readlink -f release-0.17.3/vrelease)"
test "$(readlink -f release-aa-closing/v0.17.1)" = "$(readlink -f historical/v0.17.1)"
test "$(readlink -f release-aa-closing/v0.20.1)" = "$(readlink -f historical/v0.20.1)"
