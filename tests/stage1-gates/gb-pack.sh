#!/usr/bin/env bash
# Share GA's pinned build, external install, staged assets and runtime receipt.
set -euo pipefail
exec bash tests/stage1-gates/agent-runner.sh "${1:-gb-baseline}" "" gb-run.mjs
