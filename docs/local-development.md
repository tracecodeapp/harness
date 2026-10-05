# Resuming local development

From this checkout, run:

```sh
node scripts/setup-local.mjs
```

This entry point works before node_modules exists. It uses npm to run the exact pnpm version declared in package.json, installs the frozen lockfile, then performs the repository-specific restoration and build below. Network access is needed for package downloads. Source, lockfiles, manifests, and canonical tracked release assets must still be present.

Preview the commands without installing or changing files:

```sh
node scripts/setup-local.mjs --plan
```

Check the existing local assets without installing or rebuilding:

```sh
node scripts/setup-local.mjs --check
```

A failed check stops with the original diagnostic. Missing generated files after cleanup are expected; run the setup command to restore them. Setup does not select Git branches, reset local changes, download browser engines, publish packages, deploy, or rebuild the source toolchain. Existing materializers replace their generated asset directories; keep runtime modifications in tracked source and patches.

## Harness

Use Node >=22 and <23, plus an active JDK >=17 for the Java-helper build. The installer explicitly includes the workspace root, even when .npmrc disables it. If local dependency links point at a deleted temporary review checkout, setup reinstalls the generated dependency tree. Setup restores extracted C# roles from their retained ZIPs, builds the packages, and verifies the C# role assets. It does not install the .NET SDK for normal TypeScript work.

To rebuild C# runtime source, deliberately restore the pinned SDK and workloads:

```sh
bash scripts/restore-csharp-toolchain.sh "$PWD/.dotnet/csharp-wasm"
```

The declared recipe pins SDK 10.0.110 and its workload rollback manifest. Old local SDKs 10.0.300-302 are not the supported recipe. Do not use stale DOTNET_ROOT overrides after cleanup. Follow the runtime update script's documented environment for a source rebuild.

Build a demo only when you need it:

```sh
pnpm --dir examples/project-ide build
```

Its build synchronizes generated public/workers and creates dist. The other examples use their own build commands. This avoids repopulating all demo copies during normal setup.

Preserve workers/vendor/csharp-role-artifacts and all other tracked worker assets, sources, lockfiles, toolchain recipes, local code changes and Git history. node_modules, package dist/workers, demo dist/public-workers, and extracted C# roles can be absent. Historical Harness TraceCC caches remain subject to exact compiler/PCH input verification; normal setup does not reconstruct those historical consumer hashes.
