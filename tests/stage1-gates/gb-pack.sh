#!/usr/bin/env bash
# Run from the lane checkout on the build host. All generated files stay in
# this job's disposable directory. Never build from or modify the lane tip.
set -euo pipefail
root=$(pwd)
candidate=b025fdb8220694cdfe96b136a0b8bb82843f7371
mkdir -p gb-evidence gb-subject gb-consumer
exec > >(tee "$root/gb-evidence/setup.log") 2>&1
start=$SECONDS
git cat-file -e "$candidate^{commit}"
git archive "$candidate" | tar -xf - -C gb-subject
cd gb-subject
corepack pnpm install --frozen-lockfile --prefer-offline
corepack pnpm materialize:csharp-role-assets
corepack pnpm build
corepack pnpm pack --pack-destination "$root/gb-evidence"
cd "$root/gb-consumer"
printf '%s\n' '{"private":true,"type":"module"}' >package.json
corepack pnpm add --prefer-offline ../gb-evidence/tracecode-harness-0.20.4.tgz
sha256sum "$root/gb-evidence/tracecode-harness-0.20.4.tgz"
printf 'candidate=%s setup_seconds=%s node=%s pnpm=%s\n' "$candidate" "$((SECONDS - start))" "$(node --version)" "$(corepack pnpm --version)"
