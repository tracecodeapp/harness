#!/usr/bin/env bash
set -euo pipefail
ulimit -c 0

mode=${1:?Usage: host-job.sh smoke|run [desktop-a|desktop-b|phone] [seed] [max-minutes]}
shift
case "$mode" in smoke|run) ;; *) exit 2 ;; esac
if [[ "$mode" == run && ${SPEED_EXCLUSIVE_WINDOW:-} != 1 ]]; then
  echo "An exclusive host window is required. Set SPEED_EXCLUSIVE_WINDOW=1 after coordinator approval." >&2
  exit 2
fi

out="$PWD/reports/speed-baseline-021"
mkdir -p "$out"
for version in 0.17.1 0.20.1; do
  pkg="$out/v$version"
  mkdir -p "$pkg"
  if [[ ! -f "$pkg/.installed" ]]; then
    (
      cd "$pkg"
      # npm verifies the registry integrity. Preserve the actual tarball for SHA-256.
      npm pack "@tracecode/harness@$version" --registry=https://registry.npmjs.org
      tar -xzf "tracecode-harness-$version.tgz"
      cd package
      # Published manifests include workspace-only dev dependencies. Leave dist
      # and workers untouched and resolve production dependencies in isolation.
      node -e 'const f = require("node:fs"); const p = require("./package.json"); delete p.devDependencies; f.writeFileSync("package.json", JSON.stringify(p, null, 2));'
      npm install --omit=dev --ignore-scripts --no-audit --no-fund --registry=https://registry.npmjs.org
      npm ls --omit=dev --all --json > ../dependencies.json
      node dist/cli.cjs sync-assets ../site/workers --languages python,javascript,java,cpp,csharp
      touch ../.installed
    )
  fi
done

exec node benchmarks/speed-baseline-021/run.mjs "$out" "$mode" "$@"
