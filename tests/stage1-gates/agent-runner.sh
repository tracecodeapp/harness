#!/usr/bin/env bash
# Execute inside the ar-harness.sh job directory under its heavy limiter.
set -euo pipefail

candidate=b025fdb8220694cdfe96b136a0b8bb82843f7371
canonical_sha=7669429b3c0937853eb06e3afb5c51f4f9715be86d7564e4fca4e925832f5460
subject=${TRACECODE_STAGE1_SUBJECT:-$candidate}
# A carried-forward step candidate: an exact commit plus its packed tarball and
# independently pinned SHA-256 (G7: never rebuild to compare; install the carried bytes).
carried_tarball=${TRACECODE_STAGE1_SUBJECT_TARBALL:-}
carried_sha=${TRACECODE_STAGE1_SUBJECT_SHA256:-}
carried=0
case "$subject" in
  "$candidate"|e13bf6ec1b67681eede99c8dea1df951b424eb91|15ebff79943cf991ed5f4921fd9609c3b48f33d3|published-0.17.1) ;;
  *)
    if [[ "$subject" =~ ^[0-9a-f]{40}$ && -n "$carried_tarball" && "$carried_sha" =~ ^[0-9a-f]{64}$ ]]; then
      carried=1
    else
      echo "Unrecognized gate subject $subject (a step candidate needs a 40-hex SHA plus TRACECODE_STAGE1_SUBJECT_TARBALL and TRACECODE_STAGE1_SUBJECT_SHA256)" >&2; exit 2
    fi ;;
esac
companion_repo=${TRACECODE_STAGE1_COMPANION_REPO:-/root/ci/harness.git}
job_root=$PWD
run_id=${1:-baseline}
filter=${2:-}
app_input=${3:-}
mux_input=${4:-}
canonical_tarball=${TRACECODE_STAGE1_CANONICAL_TARBALL:-/root/ci/coord-artifacts/tracecode-harness-0.20.4-b025fdb8-prelim.tgz}
case "$run_id" in
  *[!A-Za-z0-9._-]*|'') echo "Invalid run ID" >&2; exit 2 ;;
esac
mkdir -p "$job_root/gate-evidence"
evidence="$job_root/gate-evidence/$run_id"
mkdir "$evidence"
printf '%s\n' "$subject" >"$evidence/candidate.sha"
git rev-parse HEAD >"$evidence/runner.sha"
start=$SECONDS
consumer="$job_root/gate-consumer-isolated"

if [ ! -f "$job_root/gate-package.ready" ]; then
  mkdir "$job_root/gate-package"
  if [ "$subject" = "$candidate" ]; then
    printf '%s  %s\n' "$canonical_sha" "$canonical_tarball" | sha256sum --check
    cp "$canonical_tarball" "$job_root/gate-package/tracecode-harness-0.20.4.tgz"
    git clone --quiet --no-checkout "$companion_repo" "$job_root/gate-candidate"
    git -C "$job_root/gate-candidate" checkout --quiet --detach "$subject"
    git -C "$job_root/gate-candidate" rev-parse HEAD >"$evidence/companion-source.sha"
    corepack pnpm --dir "$job_root/gate-candidate" install --frozen-lockfile --prefer-offline \
      >"$evidence/companion-install.log" 2>&1 || { tail -40 "$evidence/companion-install.log"; exit 1; }
  elif [ "$carried" = 1 ]; then
    printf '%s  %s\n' "$carried_sha" "$carried_tarball" | sha256sum --check
    cp "$carried_tarball" "$job_root/gate-package/tracecode-harness-candidate.tgz"
    git clone --quiet --no-checkout "$companion_repo" "$job_root/gate-candidate"
    git -C "$job_root/gate-candidate" checkout --quiet --detach "$subject"
    git -C "$job_root/gate-candidate" rev-parse HEAD >"$evidence/companion-source.sha"
    [ "$(cat "$evidence/companion-source.sha")" = "$subject" ]
    corepack pnpm --dir "$job_root/gate-candidate" install --frozen-lockfile --prefer-offline \
      >"$evidence/companion-install.log" 2>&1 || { tail -40 "$evidence/companion-install.log"; exit 1; }
  elif [ "$subject" = published-0.17.1 ]; then
    npm pack @tracecode/harness@0.17.1 --ignore-scripts --pack-destination "$job_root/gate-package" >"$evidence/build.log" 2>&1 || { tail -60 "$evidence/build.log"; exit 1; }
  else
    git clone --quiet --no-checkout "$companion_repo" "$job_root/gate-candidate"
    git -C "$job_root/gate-candidate" checkout --quiet --detach "$subject"
    git -C "$job_root/gate-candidate" rev-parse HEAD >"$evidence/packed-source.sha"
    [ "$(cat "$evidence/packed-source.sha")" = "$subject" ]
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
  if [ "$subject" = "$candidate" ]; then
    printf '%s  %s\n' "$canonical_sha" "$tarball" | sha256sum --check
  fi
  if [ "$carried" = 1 ]; then
    printf '%s  %s\n' "$carried_sha" "$tarball" | sha256sum --check
  fi
  sha256sum "$tarball" >"$job_root/gate-package/tarball.sha256"
  printf '%s\n' "$subject" >"$job_root/gate-package.ready"
fi
[ "$(cat "$job_root/gate-package.ready")" = "$subject" ] || { echo 'Use a fresh host job for a different subject.' >&2; exit 2; }
sha256sum --check --status "$job_root/gate-package/tarball.sha256"
read -r _ tarball <"$job_root/gate-package/tarball.sha256"
if [ "$subject" = "$candidate" ]; then
  printf '%s  %s\n' "$canonical_sha" "$tarball" | sha256sum --check --status
fi
if [ "$carried" = 1 ]; then
  printf '%s  %s\n' "$carried_sha" "$tarball" | sha256sum --check --status
fi
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
cp "$job_root/gate-package/tarball.sha256" "$evidence/tarball.sha256"
printf 'host_setup_seconds=%s\nnode=%s\npnpm=%s\n' "$((SECONDS - start))" "$(node -v)" "$(corepack pnpm -v)" | tee "$evidence/host-runtime.txt"
browser_start=$SECONDS
set +e
if [ "$subject" = "$candidate" ] || [ "$carried" = 1 ]; then
  export TRACECODE_STAGE1_CANDIDATE_SOURCE="$job_root/gate-candidate"
fi
TRACECODE_STAGE1_VERIFIED_JUDGE="$installed_judge" TRACECODE_STAGE1_SUBJECT="$subject" TRACECODE_STAGE1_FILTER="$filter" TRACECODE_STAGE1_APP_INPUT="$app_input" TRACECODE_STAGE1_MUX_INPUT="$mux_input" \
  node tests/stage1-gates/run.mjs "$consumer" "$job_root/gate-assets" "$evidence"
code=$?
set -e
printf 'browser_seconds=%s\ntotal_seconds=%s\nexit=%s\n' "$((SECONDS - browser_start))" "$((SECONDS - start))" "$code" | tee -a "$evidence/host-runtime.txt"
exit "$code"
