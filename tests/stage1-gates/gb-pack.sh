#!/usr/bin/env bash
# Share GA's verified canonical tarball, external install, staged assets and runtime receipt.
set -euo pipefail
exec bash tests/stage1-gates/agent-runner.sh "${1:-gb-baseline}" "" gb-run.mjs
