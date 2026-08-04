#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOST_PROJECT_FILE="$ROOT_DIR/runtimes/csharp/TraceCode.CSharpHost/TraceCode.CSharpHost.csproj"
RUNNER_PROJECT_FILE="$ROOT_DIR/runtimes/csharp/TraceCode.CSharpJudgeRunner/TraceCode.CSharpJudgeRunner.csproj"
VENDOR_DIR="$ROOT_DIR/workers/vendor/csharp"
COMPILER_VENDOR_DIR="$ROOT_DIR/workers/vendor/csharp-compiler"
RUNNER_VENDOR_DIR="$ROOT_DIR/workers/vendor/csharp-runner"

usage() {
  cat <<'EOF'
Usage: pnpm update:csharp-runtime

Installs or updates the .NET SDK channel required by the C# browser-WASM host,
publishes the host, replaces the general/compiler/runner C# bundles, and
regenerates runtime language info plus package assets.

Environment:
  TRACECODE_DOTNET_VERSION             Install an exact SDK version instead of the target-framework channel.
  TRACECODE_DOTNET_CHANNEL             Override the SDK channel. Defaults to the C# host TargetFramework major.
  TRACECODE_DOTNET_QUALITY             dotnet-install quality. Defaults to GA.
  TRACECODE_DOTNET_INSTALL_DIR         Local SDK install dir. Defaults to .dotnet/csharp-wasm.
  TRACECODE_DOTNET_CLI_HOME            Local .NET CLI home. Defaults to .dotnet/home.
  TRACECODE_DOTNET_SKIP_INSTALL=1      Reuse the existing SDK in TRACECODE_DOTNET_INSTALL_DIR.
  TRACECODE_DOTNET_SKIP_WORKLOAD=1     Skip wasm-tools workload installation.
  TRACECODE_CSHARP_REFERENCE_PACK      Compiler reference pack. The role-split release requires Minimal (default).
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

target_framework="$(
  sed -nE 's/.*<TargetFramework>([^<]+)<\/TargetFramework>.*/\1/p' "$HOST_PROJECT_FILE" | head -n 1
)"
if [[ -z "$target_framework" ]]; then
  echo "Unable to read TargetFramework from $HOST_PROJECT_FILE" >&2
  exit 1
fi

target_major="$(sed -nE 's/^net([0-9]+)\..*$/\1/p' <<<"$target_framework")"
if [[ -z "$target_major" ]]; then
  echo "Unable to derive SDK channel from target framework $target_framework" >&2
  exit 1
fi

dotnet_install_dir="${TRACECODE_DOTNET_INSTALL_DIR:-$ROOT_DIR/.dotnet/csharp-wasm}"
dotnet_cli_home="${TRACECODE_DOTNET_CLI_HOME:-$ROOT_DIR/.dotnet/home}"
dotnet_channel="${TRACECODE_DOTNET_CHANNEL:-$target_major.0}"
dotnet_quality="${TRACECODE_DOTNET_QUALITY:-GA}"
dotnet_version="${TRACECODE_DOTNET_VERSION:-}"
dotnet_install_url="${TRACECODE_DOTNET_INSTALL_SCRIPT_URL:-https://dot.net/v1/dotnet-install.sh}"
csharp_reference_pack="${TRACECODE_CSHARP_REFERENCE_PACK:-Minimal}"

if [[ "$csharp_reference_pack" != "Minimal" ]]; then
  echo "The role-split C# release requires TRACECODE_CSHARP_REFERENCE_PACK=Minimal." >&2
  echo "A broader compiler pack must ship a correspondingly rooted runner; refusing a compile/execute surface mismatch." >&2
  exit 1
fi

mkdir -p "$dotnet_install_dir" "$dotnet_cli_home"

if [[ "${TRACECODE_DOTNET_SKIP_INSTALL:-0}" != "1" ]]; then
  installer_dir="$(mktemp -d)"
  trap 'rm -rf "$installer_dir"' EXIT
  installer="$installer_dir/dotnet-install.sh"
  curl -fsSL "$dotnet_install_url" -o "$installer"
  chmod +x "$installer"

  install_args=(--install-dir "$dotnet_install_dir" --no-path)
  if [[ -n "$dotnet_version" ]]; then
    install_args+=(--version "$dotnet_version")
  else
    install_args+=(--channel "$dotnet_channel" --quality "$dotnet_quality")
  fi

  "$installer" "${install_args[@]}"
fi

export DOTNET_ROOT="$dotnet_install_dir"
export DOTNET_CLI_HOME="$dotnet_cli_home"
export DOTNET_NOLOGO=1
export DOTNET_SKIP_FIRST_TIME_EXPERIENCE=1
export PATH="$DOTNET_ROOT:$PATH"

if [[ ! -x "$DOTNET_ROOT/dotnet" ]]; then
  echo "Missing dotnet executable at $DOTNET_ROOT/dotnet" >&2
  echo "Run without TRACECODE_DOTNET_SKIP_INSTALL=1 or set TRACECODE_DOTNET_INSTALL_DIR." >&2
  exit 1
fi

"$DOTNET_ROOT/dotnet" --info

if [[ "${TRACECODE_DOTNET_SKIP_WORKLOAD:-0}" != "1" ]]; then
  "$DOTNET_ROOT/dotnet" workload install wasm-tools
fi

"$DOTNET_ROOT/dotnet" publish "$HOST_PROJECT_FILE" -c Release \
  -p:TraceCodeCompilerReferencePack="$csharp_reference_pack"
"$DOTNET_ROOT/dotnet" publish "$RUNNER_PROJECT_FILE" -c Release \
  -p:TraceCodeRunnerTrimProfile=JudgeReferences \
  -p:PublishTrimmed=true \
  -p:TrimMode=partial \
  -p:JsonSerializerIsReflectionEnabledByDefault=true

host_publish_dir="$ROOT_DIR/runtimes/csharp/TraceCode.CSharpHost/bin/Release/$target_framework/browser-wasm/AppBundle"
runner_publish_dir="$ROOT_DIR/runtimes/csharp/TraceCode.CSharpJudgeRunner/bin/Release/$target_framework/browser-wasm/AppBundle"
if [[ ! -f "$host_publish_dir/_framework/dotnet.js" ]]; then
  echo "Missing published Host AppBundle at $host_publish_dir" >&2
  exit 1
fi
if [[ ! -f "$runner_publish_dir/_framework/dotnet.js" ]]; then
  echo "Missing published Judge runner AppBundle at $runner_publish_dir" >&2
  exit 1
fi

tmp_vendor="$VENDOR_DIR.tmp.$$"
tmp_compiler_vendor="$COMPILER_VENDOR_DIR.tmp.$$"
tmp_runner_vendor="$RUNNER_VENDOR_DIR.tmp.$$"
rm -rf "$tmp_vendor" "$tmp_compiler_vendor" "$tmp_runner_vendor"
cp -R "$host_publish_dir" "$tmp_vendor"
cp -R "$host_publish_dir" "$tmp_compiler_vendor"
cp -R "$runner_publish_dir" "$tmp_runner_vendor"

for role_vendor in "$tmp_vendor" "$tmp_compiler_vendor" "$tmp_runner_vendor"; do
  if [[ -f "$role_vendor/_framework/dotnet.native.js" ]]; then
    perl -pi -e 's/[ \t]+$//' "$role_vendor/_framework/dotnet.native.js"
  fi
  pnpm exec tsx "$ROOT_DIR/scripts/prune-csharp-wasm-runtime-assets.ts" "$role_vendor"
done
pnpm exec tsx "$ROOT_DIR/scripts/validate-csharp-runtime-role-assets.ts" \
  "$tmp_vendor" "$tmp_compiler_vendor" "$tmp_runner_vendor"

rm -rf "$VENDOR_DIR" "$COMPILER_VENDOR_DIR" "$RUNNER_VENDOR_DIR"
mv "$tmp_vendor" "$VENDOR_DIR"
mv "$tmp_compiler_vendor" "$COMPILER_VENDOR_DIR"
mv "$tmp_runner_vendor" "$RUNNER_VENDOR_DIR"

(
  cd "$ROOT_DIR"
  pnpm run generate:runtime-info
  pnpm run sync:package-assets
  pnpm run test:runtime-info-sync
)

echo "Updated C# general/compiler/runner runtime assets."
