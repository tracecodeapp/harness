#!/usr/bin/env bash
set -euo pipefail
stage="$(cd "$(dirname "$0")" && pwd)"
cd "$stage"
mkdir -p submit-aa
ln -sfn ../historical/v0.17.1 submit-aa/v0.17.1
ln -sfn ../historical/v0.20.1 submit-aa/v0.20.1
test "$(readlink -f submit-aa/v0.17.1)" = "$(readlink -f historical/v0.17.1)"
test "$(readlink -f submit-aa/v0.20.1)" = "$(readlink -f historical/v0.20.1)"
