#!/usr/bin/env bash
# Execute inside the ar-harness.sh job directory under its heavy limiter.
set -euo pipefail

candidate=b025fdb8220694cdfe96b136a0b8bb82843f7371
canonical_sha=7669429b3c0937853eb06e3afb5c51f4f9715be86d7564e4fca4e925832f5460
canonical_tarball=${TRACECODE_STAGE1_CANONICAL_TARBALL:-/root/ci/coord-artifacts/tracecode-harness-0.20.4-b025fdb8-prelim.tgz}
job_root=$PWD
run_id=${1:-baseline}
filter=${2:-}
runner=${3:-run.mjs}
case "$run_id" in
  *[!A-Za-z0-9._-]*|'') echo "Invalid run ID" >&2; exit 2 ;;
esac
mkdir -p "$job_root/gate-evidence"
evidence="$job_root/gate-evidence/$run_id"
mkdir "$evidence"
printf '%s\n' "$candidate" >"$evidence/candidate.sha"
git rev-parse HEAD >"$evidence/runner.sha"
start=$SECONDS
consumer="$job_root/gate-consumer-isolated"

package_dir="$job_root/gate-package"
tarball="$package_dir/tracecode-harness-0.20.4.tgz"
mkdir -p "$package_dir"
printf '%s  %s\n' "$canonical_sha" "$canonical_tarball" >"$evidence/canonical-tarball.sha256"
sha256sum --check "$evidence/canonical-tarball.sha256"
if [ ! -f "$tarball" ]; then
  cp "$canonical_tarball" "$tarball"
fi
printf '%s  %s\n' "$canonical_sha" "$tarball" >"$evidence/tarball.sha256"
sha256sum --check "$evidence/tarball.sha256"
if [ ! -f "$consumer/.installed" ]; then
  mkdir -p "$consumer"
  printf '%s\n' '{"name":"stage1-gates-consumer","private":true,"type":"module"}' >"$consumer/package.json"
  (
    cd "$consumer"
    corepack pnpm --ignore-workspace add --prefer-offline --ignore-scripts "$tarball"
    node node_modules/@tracecode/harness/dist/cli.cjs sync-assets "$job_root/gate-assets" --inventory
  ) >"$evidence/install-assets.log" 2>&1 || { tail -60 "$evidence/install-assets.log"; exit 1; }
  touch "$consumer/.installed"
fi
packed_judge_sha=$(tar -xOzf "$tarball" package/dist/judge.js | sha256sum | cut -d' ' -f1)
installed_judge=$(realpath "$consumer/node_modules/@tracecode/harness/dist/judge.js")
case "$installed_judge" in
  "$consumer/node_modules/.pnpm/"*) ;;
  *) echo "Judge resolved outside the isolated consumer store: $installed_judge" >&2; exit 2 ;;
esac
printf '%s  %s\n' "$packed_judge_sha" "$installed_judge" >"$evidence/installed-judge.sha256"
sha256sum --check "$evidence/installed-judge.sha256"
printf 'host_setup_seconds=%s\nnode=%s\npnpm=%s\n' "$((SECONDS - start))" "$(node -v)" "$(corepack pnpm -v)" | tee "$evidence/host-runtime.txt"
browser_start=$SECONDS
set +e
TRACECODE_STAGE1_VERIFIED_JUDGE="$installed_judge" TRACECODE_STAGE1_FILTER="$filter" \
  node "tests/stage1-gates/$runner" "$consumer" "$job_root/gate-assets" "$evidence"
code=$?
set -e
printf 'browser_seconds=%s\ntotal_seconds=%s\nexit=%s\n' "$((SECONDS - browser_start))" "$((SECONDS - start))" "$code" | tee -a "$evidence/host-runtime.txt"
exit "$code"
