#!/usr/bin/env bash
# Execute inside the ar-harness.sh job directory under its heavy limiter.
set -euo pipefail

candidate=b025fdb8220694cdfe96b136a0b8bb82843f7371
subject=${TRACECODE_STAGE1_SUBJECT:-$candidate}
case "$subject" in
  "$candidate"|e13bf6ec1b67681eede99c8dea1df951b424eb91|15ebff79943cf991ed5f4921fd9609c3b48f33d3|published-0.17.1) ;;
  *) echo "Unrecognized gate subject $subject" >&2; exit 2 ;;
esac
job_root=$PWD
run_id=${1:-baseline}
filter=${2:-}
app_input=${3:-}
mux_input=${4:-}
case "$run_id" in
  *[!A-Za-z0-9._-]*|'') echo "Invalid run ID" >&2; exit 2 ;;
esac
mkdir -p "$job_root/gate-evidence"
evidence="$job_root/gate-evidence/$run_id"
mkdir "$evidence"
printf '%s\n' "$subject" >"$evidence/candidate.sha"
git rev-parse HEAD >"$evidence/runner.sha"
start=$SECONDS

if [ ! -f "$job_root/gate-package.ready" ]; then
  mkdir "$job_root/gate-package"
  if [ "$subject" = published-0.17.1 ]; then
    npm pack @tracecode/harness@0.17.1 --ignore-scripts --pack-destination "$job_root/gate-package" >"$evidence/build.log" 2>&1 || { tail -60 "$evidence/build.log"; exit 1; }
  else
    git clone --quiet --no-checkout /root/ci/harness.git "$job_root/gate-candidate"
    git -C "$job_root/gate-candidate" checkout --quiet --detach "$subject"
    (
      cd "$job_root/gate-candidate"
      corepack pnpm install --frozen-lockfile --prefer-offline
      corepack pnpm materialize:csharp-role-assets
      corepack pnpm build
      git diff --stat
      corepack pnpm pack --pack-destination "$job_root/gate-package"
    ) >"$evidence/build.log" 2>&1 || { tail -60 "$evidence/build.log"; exit 1; }
    git -C "$job_root/gate-candidate" diff --binary >"$evidence/candidate-build.diff"
  fi
  tarball=$(find "$job_root/gate-package" -maxdepth 1 -name '*.tgz')
  sha256sum "$tarball" >"$job_root/gate-package/tarball.sha256"
  mkdir "$job_root/gate-consumer"
  printf '%s\n' '{"name":"stage1-gates-consumer","private":true,"type":"module"}' >"$job_root/gate-consumer/package.json"
  (
    cd "$job_root/gate-consumer"
    corepack pnpm add --prefer-offline --ignore-scripts "$tarball"
    node node_modules/@tracecode/harness/dist/cli.cjs sync-assets "$job_root/gate-assets" --inventory
  ) >"$evidence/install-assets.log" 2>&1 || { tail -60 "$evidence/install-assets.log"; exit 1; }
  printf '%s\n' "$subject" >"$job_root/gate-package.ready"
fi
[ "$(cat "$job_root/gate-package.ready")" = "$subject" ] || { echo 'Use a fresh host job for a different subject.' >&2; exit 2; }
cp "$job_root/gate-package/tarball.sha256" "$evidence/tarball.sha256"
printf 'host_setup_seconds=%s\nnode=%s\npnpm=%s\n' "$((SECONDS - start))" "$(node -v)" "$(corepack pnpm -v)" | tee "$evidence/host-runtime.txt"
browser_start=$SECONDS
set +e
if [ "$subject" = "$candidate" ]; then
  export TRACECODE_STAGE1_CANDIDATE_SOURCE="$job_root/gate-candidate"
fi
TRACECODE_STAGE1_SUBJECT="$subject" TRACECODE_STAGE1_FILTER="$filter" TRACECODE_STAGE1_APP_INPUT="$app_input" TRACECODE_STAGE1_MUX_INPUT="$mux_input" \
  node tests/stage1-gates/run.mjs "$job_root/gate-consumer" "$job_root/gate-assets" "$evidence"
code=$?
set -e
printf 'browser_seconds=%s\ntotal_seconds=%s\nexit=%s\n' "$((SECONDS - browser_start))" "$((SECONDS - start))" "$code" | tee -a "$evidence/host-runtime.txt"
exit "$code"
