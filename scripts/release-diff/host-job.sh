#!/bin/bash
# Build-host job for the cross-version release diff. Run from the checkout root through
# harness-artifacts/tools/ar-harness.sh, e.g.
#   ar-harness.sh <wt> rd-dry bash scripts/release-diff/host-job.sh
# Environment (all optional): RD_LANGUAGES (default all six, cheapest first), RD_PROBLEMS,
# RD_CATALOG (default all), RD_BASE_VERSION (default 0.17.1), RD_SKIP_BUILD=1.
# RD_RERUN_FILE: lines "<language> <id>,<id>" rerun only those problems (with RD_OUT=rerun-out).
# RD_NOSTOP_SIDE=1 (rerun mode): also run the target without stopAtFirstRunaway (target-nostop).
# RD_SIDES="target target-nostop": run only the listed sides. Rerun reports are <label>-<lang>-<line>.json.
# Output: release-diff-out/<label>-<language>.json and logs, copied back with scp.
set -uo pipefail
ROOT=$(pwd)
OUT="$ROOT/${RD_OUT:-release-diff-out}"
CORPUS=${RD_CORPUS:-/root/ci/parity-app-data}
BASE_VERSION=${RD_BASE_VERSION:-0.17.1}
LANGS=${RD_LANGUAGES:-javascript,typescript,cpp,java,csharp,python}
mkdir -p "$OUT"

# The baseline is the published package production installs, unpacked with its own
# production dependencies. npm verifies the registry integrity hash on download.
BASE="$ROOT/.release-diff/harness-$BASE_VERSION"
if [ ! -f "$BASE/.installed" ]; then
  rm -rf "$BASE" && mkdir -p "$BASE" && cd "$BASE" || exit 10
  npm pack "@tracecode/harness@$BASE_VERSION" --silent >pack.log 2>&1 || { cat pack.log; exit 11; }
  tar xzf "tracecode-harness-$BASE_VERSION.tgz" || exit 12
  # Its devDependencies name unpublished workspace packages, which npm resolves even with
  # --omit=dev; drop them from the unpacked manifest (dist/ and workers/ are untouched).
  cd package && node -e "const f=require(\"fs\");const p=JSON.parse(f.readFileSync(\"package.json\"));delete p.devDependencies;f.writeFileSync(\"package.json\",JSON.stringify(p,null,2))" || exit 14
  npm install --omit=dev --ignore-scripts --no-audit --no-fund >"$OUT/base-install.log" 2>&1 \
    || { tail -30 "$OUT/base-install.log"; exit 13; }
  [ -f node_modules/@tracecode/tracecc/package.json ] && [ -d node_modules/effect ] || { echo "baseline deps missing"; exit 15; }
  touch "$BASE/.installed"
  cd "$ROOT"
fi
sha256sum "$BASE/tracecode-harness-$BASE_VERSION.tgz" >"$OUT/base-package.sha256"
(cd "$BASE/package" && npm ls --omit=dev --depth=0 >"$OUT/base-deps.txt" 2>&1)

if [ "${RD_SKIP_BUILD:-0}" != 1 ]; then
  { corepack pnpm materialize:csharp-role-assets && corepack pnpm build; } >"$OUT/target-build.log" 2>&1 \
    || { tail -40 "$OUT/target-build.log"; exit 20; }
fi
git rev-parse HEAD >"$OUT/target-head.txt"

status=0
# RD_PARALLEL=1 runs both versions of a language side by side (two browser processes, within
# the host's four-workers-per-job rule), so both see the same host load.
run_side() {
  local lang=$1 side=$2 root label stop
  if [ "$side" = base ]; then root="$BASE/package"; label="v$BASE_VERSION"; stop=0
  elif [ "$side" = target-nostop ]; then root="$ROOT"; label=target-nostop; stop=0
  else root="$ROOT"; label=target; stop=1; fi
  echo "== $label $lang start $(date -u +%H:%M:%SZ)"
  RD_HARNESS_ROOT="$root" RD_LABEL="$label" RD_STOP_SUBMIT="$stop" RD_CORPUS="$CORPUS" \
    RD_CATALOG="${RD_CATALOG:-all}" RD_LANGUAGES="$lang" RD_PROBLEMS="${RD_PROBLEMS:-}" \
    RD_REPORT="$OUT/$label-$lang${RUN_TAG:+-$RUN_TAG}.json" \
    corepack pnpm exec tsx --tsconfig tsconfig.base.json tests/test-release-diff-catalog.ts \
    </dev/null >"$OUT/$label-$lang${RUN_TAG:+-$RUN_TAG}.log" 2>&1
  local code=$?
  echo "== $label $lang${RUN_TAG:+ #$RUN_TAG} end $(date -u +%H:%M:%SZ) exit=$code fixtures=$(grep -cE '^\[' "$OUT/$label-$lang${RUN_TAG:+-$RUN_TAG}.log")"
  grep -E 'runner-timeout|crashed|Error' "$OUT/$label-$lang${RUN_TAG:+-$RUN_TAG}.log" | head -5
  return $code
}
run_lang() {
  local lang=$1
  # RD_SIDES (e.g. "target target-nostop") runs only those sides, one after another.
  if [ -n "${RD_SIDES:-}" ]; then
    for side in $RD_SIDES; do run_side "$lang" "$side" || status=1; done
    return
  fi
  if [ "${RD_PARALLEL:-0}" = 1 ]; then
    run_side "$lang" base & local b=$!
    run_side "$lang" target & local t=$!
    wait $b || status=1
    wait $t || status=1
  else
    run_side "$lang" base || status=1
    run_side "$lang" target || status=1
  fi
  # Separates Harness changes from the app's Submit option (main sends stopAtFirstRunaway).
  if [ "${RD_NOSTOP_SIDE:-0}" = 1 ]; then run_side "$lang" target-nostop || status=1; fi
}
if [ -n "${RD_RERUN_FILE:-}" ]; then
  line_no=0
  while read -r lang ids; do
    [ -n "$lang" ] || continue
    line_no=$((line_no + 1))
    # Each line gets its own report files (RUN_TAG), so a line may repeat to measure a rate.
    RUN_TAG="$line_no" RD_PROBLEMS="$ids" run_lang "$lang"
  done <"$RD_RERUN_FILE"
  echo "done $(date -u +%H:%M:%SZ)"
  exit $status
fi
IFS=, read -ra LANG_LIST <<<"$LANGS"
for lang in "${LANG_LIST[@]}"; do
  if [ "${RD_PARALLEL:-0}" = 1 ]; then
    run_side "$lang" base & b=$!
    run_side "$lang" target & t=$!
    wait $b || status=1
    wait $t || status=1
  else
    run_side "$lang" base || status=1
    run_side "$lang" target || status=1
  fi
done
echo "done $(date -u +%H:%M:%SZ)"
exit $status
