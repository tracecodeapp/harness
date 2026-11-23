#!/usr/bin/env bash
# Execute inside the ar-harness.sh job directory under its heavy limiter.
set -euo pipefail

candidate=b025fdb8220694cdfe96b136a0b8bb82843f7371
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

if [ ! -f "$job_root/gate-package.ready" ]; then
  git clone --quiet --no-checkout /root/ci/harness.git "$job_root/gate-candidate"
  git -C "$job_root/gate-candidate" checkout --quiet --detach "$candidate"
  (
    cd "$job_root/gate-candidate"
    corepack pnpm install --frozen-lockfile --prefer-offline
    corepack pnpm materialize:csharp-role-assets
    corepack pnpm build
    git diff --stat
    mkdir "$job_root/gate-package"
    corepack pnpm pack --pack-destination "$job_root/gate-package"
  ) >"$evidence/build.log" 2>&1 || { tail -60 "$evidence/build.log"; exit 1; }
  git -C "$job_root/gate-candidate" diff --binary >"$evidence/candidate-build.diff"
  tarball=$(find "$job_root/gate-package" -maxdepth 1 -name '*.tgz')
  sha256sum "$tarball" >"$job_root/gate-package/tarball.sha256"
  touch "$job_root/gate-package.ready"
fi
sha256sum --check --status "$job_root/gate-package/tarball.sha256"
if [ ! -f "$consumer/.installed" ]; then
  read -r _ tarball <"$job_root/gate-package/tarball.sha256"
  mkdir -p "$consumer"
  printf '%s\n' '{"name":"stage1-gates-consumer","private":true,"type":"module"}' >"$consumer/package.json"
  (
    cd "$consumer"
    corepack pnpm --ignore-workspace add --prefer-offline --ignore-scripts "$tarball"
    node node_modules/@tracecode/harness/dist/cli.cjs sync-assets "$job_root/gate-assets" --inventory
  ) >"$evidence/install-assets.log" 2>&1 || { tail -60 "$evidence/install-assets.log"; exit 1; }
  touch "$consumer/.installed"
fi
cp "$job_root/gate-package/tarball.sha256" "$evidence/tarball.sha256"
printf 'host_setup_seconds=%s\nnode=%s\npnpm=%s\n' "$((SECONDS - start))" "$(node -v)" "$(corepack pnpm -v)" | tee "$evidence/host-runtime.txt"
browser_start=$SECONDS
set +e
TRACECODE_STAGE1_FILTER="$filter" node "tests/stage1-gates/$runner" "$consumer" "$job_root/gate-assets" "$evidence"
code=$?
set -e
printf 'browser_seconds=%s\ntotal_seconds=%s\nexit=%s\n' "$((SECONDS - browser_start))" "$((SECONDS - start))" "$code" | tee -a "$evidence/host-runtime.txt"
exit "$code"
