#!/bin/bash
# Build-host job for the cross-version release diff. Run from the checkout root through
# harness-artifacts/tools/ar-harness.sh, e.g.
#   ar-harness.sh <wt> rd-dry bash scripts/release-diff/host-job.sh
# Environment (all optional): RD_LANGUAGES (default all six, cheapest first), RD_PROBLEMS,
# RD_CATALOG (default all), RD_BASE_VERSION (default 0.17.1), RD_SKIP_BUILD=1.
# Output: release-diff-out/<label>-<language>.json and logs, copied back with scp.
set -uo pipefail
ROOT=$(pwd)
OUT="$ROOT/release-diff-out"
CORPUS=${RD_CORPUS:-/root/ci/parity-app-data}
BASE_VERSION=${RD_BASE_VERSION:-0.17.1}
LANGS=${RD_LANGUAGES:-javascript,typescript,cpp,java,csharp,python}
mkdir -p "$OUT"

# The baseline is the published package production installs, unpacked with its own
# production dependencies. npm verifies the registry integrity hash on download.
BASE="$ROOT/.release-diff/harness-$BASE_VERSION"
if [ ! -f "$BASE/package/dist/judge.js" ]; then
  rm -rf "$BASE" && mkdir -p "$BASE" && cd "$BASE" || exit 10
  npm pack "@tracecode/harness@$BASE_VERSION" --silent >pack.log 2>&1 || { cat pack.log; exit 11; }
  tar xzf "tracecode-harness-$BASE_VERSION.tgz" || exit 12
  cd package && npm install --omit=dev --ignore-scripts --no-audit --no-fund >"$OUT/base-install.log" 2>&1 \
    || { tail -30 "$OUT/base-install.log"; exit 13; }
  cd "$ROOT"
fi
sha256sum "$BASE/tracecode-harness-$BASE_VERSION.tgz" >"$OUT/base-package.sha256"

if [ "${RD_SKIP_BUILD:-0}" != 1 ]; then
  { corepack pnpm materialize:csharp-role-assets && corepack pnpm build; } >"$OUT/target-build.log" 2>&1 \
    || { tail -40 "$OUT/target-build.log"; exit 20; }
fi
git rev-parse HEAD >"$OUT/target-head.txt"

status=0
IFS=, read -ra LANG_LIST <<<"$LANGS"
for lang in "${LANG_LIST[@]}"; do
  for side in base target; do
    if [ "$side" = base ]; then root="$BASE/package"; label="v$BASE_VERSION"; stop=0
    else root="$ROOT"; label=target; stop=1; fi
    echo "== $label $lang $(date -u +%H:%M:%SZ)"
    RD_HARNESS_ROOT="$root" RD_LABEL="$label" RD_STOP_SUBMIT="$stop" RD_CORPUS="$CORPUS" \
      RD_CATALOG="${RD_CATALOG:-all}" RD_LANGUAGES="$lang" RD_PROBLEMS="${RD_PROBLEMS:-}" \
      RD_REPORT="$OUT/$label-$lang.json" \
      corepack pnpm exec tsx --tsconfig tsconfig.base.json tests/test-release-diff-catalog.ts \
      >"$OUT/$label-$lang.log" 2>&1 || { echo "   exit $? (see $label-$lang.log)"; status=1; }
    grep -cE '^\[' "$OUT/$label-$lang.log" | sed 's/^/   problems logged: /'
    grep -E 'runner-timeout|crashed|Error' "$OUT/$label-$lang.log" | head -5
  done
done
echo "done $(date -u +%H:%M:%SZ)"
exit $status
