#!/usr/bin/env bash
# Reinstalls the pinned .NET SDK (10.0.110 + wasm-tools) from upstream sources
# using the fully pinned recipe in toolchains/csharp/ (vendored installer,
# exact SDK version, workload rollback file). Nothing in this toolchain is
# built by us, so we vendor the recipe rather than the bits; see
# toolchains/csharp/manifest.json for provenance and rebuild caveats.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TOOLCHAIN_DIR="$REPO_ROOT/toolchains/csharp"
DEST="${1:-$HOME/.dotnet-10.0.110}"
SDK_VERSION="$(python3 -c "import json;print(json.load(open('$TOOLCHAIN_DIR/manifest.json'))['sdkVersion'])")"

if [ ! -x "$DEST/dotnet" ]; then
  bash "$TOOLCHAIN_DIR/dotnet-install.sh" --version "$SDK_VERSION" --install-dir "$DEST"
fi

export DOTNET_ROOT="$DEST"
export PATH="$DEST:$PATH"
export DOTNET_CLI_TELEMETRY_OPTOUT=1

ACTUAL_VERSION="$("$DEST/dotnet" --version)"
if [ "$ACTUAL_VERSION" != "$SDK_VERSION" ]; then
  echo "SDK version mismatch: expected $SDK_VERSION got $ACTUAL_VERSION" >&2
  exit 1
fi

"$DEST/dotnet" workload install wasm-tools \
  --from-rollback-file "$TOOLCHAIN_DIR/workload-rollback.json"

python3 - "$TOOLCHAIN_DIR/manifest.json" "$DEST" <<'EOF'
import json, os, sys
manifest = json.load(open(sys.argv[1]))
dest = sys.argv[2]
failures = []
for pack, version in manifest['expectedPacks'].items():
    if '.osx-arm64' in pack and os.uname().machine != 'arm64':
        continue
    if not os.path.isdir(os.path.join(dest, 'packs', pack, version)):
        failures.append(f'{pack}/{version}')
if failures:
    sys.exit('missing expected packs: ' + ', '.join(failures))
print('all expected packs present')
EOF

echo "restored to $DEST"
echo "use with: export DOTNET_ROOT=\"$DEST\" PATH=\"$DEST:\$PATH\""
