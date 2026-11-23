#!/usr/bin/env bash
# Run from any full Harness checkout with Node 22, pnpm dependencies and full Chromium.
# Usage: bash scripts/run-untraced-host-history.sh [language[,language...]]
set -euo pipefail
cd "$(dirname "$0")/.."

# The asset CLI stages the release's checked-in workers and materializes the
# selected runtime artifacts. The browser driver bundles this checkout's source.
exec corepack pnpm exec tsx --tsconfig tsconfig.base.json scripts/check-untraced-host-history.mjs "${1:-cpp,java,python,csharp,javascript,typescript}"
