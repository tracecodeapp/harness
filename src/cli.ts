#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { copyFile, cp, mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { materializeCSharpRoleAssets } from '../scripts/csharp-role-artifacts.js';
import {
  installEngineRuntimePackage,
  loadEngineRuntimePackages,
} from '../scripts/runtime-package-assets.mjs';
import {
  ASSET_COPY_PLAN,
  PACKAGE_PATH_EXCLUDES,
  computeStagedInventory,
  selectsAsset,
  stagedPathGroups,
  type AssetCopyPlanEntry,
  type AssetLanguage,
  type StagedInventory,
} from '../scripts/runtime-asset-staging.js';

function usage(): string {
  return [
    'Usage:',
    '  tracecode-harness sync-assets <target-dir> [--languages python,javascript,java,csharp,cpp] [--inventory]',
    '',
    '  --inventory  after syncing, print the staged inventory as JSON on stdout:',
    '               every staged file with its size, sha256 and class (locked,',
    '               alias of a locked file, or metadata), the totals, and files',
    '               in the target directory that the Harness did not stage.',
    '',
    'Example:',
    '  tracecode-harness sync-assets public/workers',
    '  tracecode-harness sync-assets public/workers --languages python,javascript',
    '  tracecode-harness sync-assets public/workers --inventory > inventory.json',
  ].join('\n');
}

async function ensureParentDir(pathname: string): Promise<void> {
  await mkdir(dirname(pathname), { recursive: true });
}

function getPackageRoot(): string {
  const cliEntrypoint = process.argv[1];
  if (!cliEntrypoint) {
    throw new Error('Unable to resolve tracecode-harness CLI entrypoint');
  }
  return resolve(dirname(realpathSync(cliEntrypoint)), '..');
}

function resolveAssetSourcePath(packageRoot: string, asset: AssetCopyPlanEntry): string {
  return join(packageRoot, ...asset.source);
}

function normalizeLanguage(rawLanguage: string): AssetLanguage {
  const normalized = rawLanguage.trim().toLowerCase();
  if (normalized === 'js' || normalized === 'ts' || normalized === 'typescript') return 'javascript';
  if (normalized === 'javascript') return 'javascript';
  if (normalized === 'py' || normalized === 'python') return 'python';
  if (normalized === 'java') return 'java';
  if (normalized === 'cs' || normalized === 'c#' || normalized === 'csharp') return 'csharp';
  if (normalized === 'cc' || normalized === 'cxx' || normalized === 'c++' || normalized === 'cpp') return 'cpp';
  throw new Error(`Unsupported language "${rawLanguage}". Expected python, javascript, java, csharp, or cpp.`);
}

interface SyncOptions {
  readonly languages: Set<AssetLanguage> | null;
  readonly inventory: boolean;
}

function parseSyncOptions(args: string[]): SyncOptions {
  const selectedLanguages = new Set<AssetLanguage>();
  let inventory = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    let rawValue: string | undefined;

    if (arg === '--inventory') {
      inventory = true;
      continue;
    } else if (arg === '--language' || arg === '--languages') {
      rawValue = args[index + 1];
      index += 1;
    } else if (arg?.startsWith('--language=')) {
      rawValue = arg.slice('--language='.length);
    } else if (arg?.startsWith('--languages=')) {
      rawValue = arg.slice('--languages='.length);
    } else {
      throw new Error(`Unknown option "${arg}"`);
    }

    if (!rawValue) {
      throw new Error(`Missing value for ${arg}`);
    }

    for (const rawLanguage of rawValue.split(',')) {
      selectedLanguages.add(normalizeLanguage(rawLanguage));
    }
  }

  return {
    languages: selectedLanguages.size > 0 ? selectedLanguages : null,
    inventory,
  };
}

async function syncAssets(targetDir: string, options: SyncOptions): Promise<void> {
  const selectedLanguages = options.languages;
  const packageRoot = getPackageRoot();
  const resolvedTargetDir = resolve(process.cwd(), targetDir);
  const wantsJava = !selectedLanguages || selectedLanguages.has('java');
  const wantsCpp = !selectedLanguages || selectedLanguages.has('cpp');
  const engines = wantsJava || wantsCpp || options.inventory
    ? await loadEngineRuntimePackages(packageRoot)
    : undefined;
  if (engines && (wantsJava || wantsCpp)) {
    if (wantsJava) {
      await rm(join(resolvedTargetDir, 'java/tracejvm'), {
        recursive: true,
        force: true,
      });
      await installEngineRuntimePackage(engines.tracejvm, resolvedTargetDir);
    }
    if (wantsCpp) {
      await rm(join(resolvedTargetDir, 'cpp/tracecc'), {
        recursive: true,
        force: true,
      });
      await installEngineRuntimePackage(engines.tracecc, resolvedTargetDir);
    }
  }
  if (!selectedLanguages || selectedLanguages.has('csharp')) {
    await rm(join(resolvedTargetDir, 'vendor/csharp-compiler'), {
      recursive: true,
      force: true,
    });
    const roleArtifactManifest = join(
      packageRoot,
      'workers/vendor/csharp-role-artifacts/manifest.json'
    );
    const hasCanonicalRoleArtifacts = await stat(roleArtifactManifest).then(
      () => true,
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return false;
        throw error;
      }
    );
    // Source checkouts retain only canonical, content-addressed archives.
    // Published packages omit those archives and contain the expanded trees.
    if (hasCanonicalRoleArtifacts) {
      await materializeCSharpRoleAssets(packageRoot);
    }
  }

  for (const asset of ASSET_COPY_PLAN) {
    if (!selectsAsset(asset, selectedLanguages)) continue;
    const sourcePath = resolveAssetSourcePath(packageRoot, asset);
    const targetPath = join(resolvedTargetDir, ...asset.target);
    const sourceStat = await stat(sourcePath);
    await ensureParentDir(targetPath);
    if (sourceStat.isDirectory()) {
      // Stage what the published package contains: a source checkout's
      // materialization stamps and build-only files stay behind.
      await cp(sourcePath, targetPath, {
        recursive: true,
        force: true,
        filter: (candidate) => {
          const packagePath = relative(packageRoot, candidate).split(sep).join('/');
          return !PACKAGE_PATH_EXCLUDES.some((pattern) => pattern.test(packagePath));
        },
      });
    } else {
      await copyFile(sourcePath, targetPath);
    }
  }

  if (!options.inventory || !engines) {
    console.log(`Synced harness assets to ${resolvedTargetDir}`);
    return;
  }
  console.error(`Synced harness assets to ${resolvedTargetDir}`);
  const inventory = await computeStagedInventory({
    packageRoot,
    engines,
    traceccLockedPaths: await traceccLockedPaths(packageRoot),
    languages: selectedLanguages,
  });
  process.stdout.write(
    `${JSON.stringify(await inventoryReport(packageRoot, resolvedTargetDir, inventory), null, 2)}\n`
  );
}

async function traceccLockedPaths(packageRoot: string): Promise<Set<string>> {
  const lock = JSON.parse(
    await readFile(join(packageRoot, 'runtime-assets.lock.json'), 'utf8')
  ) as { engineDependencies?: { tracecc?: { files?: { path: string }[] } } };
  return new Set((lock.engineDependencies?.tracecc?.files ?? []).map((file) => file.path));
}

async function listTargetFiles(root: string, prefix = ''): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...(await listTargetFiles(root, path)));
    else files.push(path);
  }
  return files;
}

/**
 * The staged inventory, verified against the target directory: every staged
 * file must be there with its recorded size and sha256. Files the Harness did
 * not stage (the consumer's own, or stale ones) are listed, not removed.
 */
async function inventoryReport(packageRoot: string, targetDir: string, inventory: StagedInventory) {
  const mismatched: string[] = [];
  for (const file of inventory.files) {
    try {
      const bytes = await readFile(join(targetDir, ...file.path.split('/')));
      const digest = createHash('sha256').update(bytes).digest('hex');
      if (bytes.byteLength !== file.size || digest !== file.sha256) mismatched.push(file.path);
    } catch {
      mismatched.push(file.path);
    }
  }
  if (mismatched.length > 0) {
    throw new Error(`Staged files do not match the inventory: ${mismatched.slice(0, 10).join(', ')}`);
  }
  const staged = new Set(inventory.files.map((file) => file.path));
  const notStaged = (await listTargetFiles(targetDir)).filter((path) => !staged.has(path)).sort();
  const lock = JSON.parse(await readFile(join(packageRoot, 'runtime-assets.lock.json'), 'utf8')) as {
    harness?: { releaseId?: string };
    stagedInventory?: { files?: number; bytes?: number };
  };
  const allLanguages = inventory.languages.length === 5;
  return {
    schema: 'tracecode.staged-inventory.v1',
    harness: lock.harness?.releaseId,
    target: targetDir,
    languages: inventory.languages,
    totals: inventory.totals,
    ...(allLanguages
      ? {
          matchesLock:
            lock.stagedInventory?.files === inventory.totals.files &&
            lock.stagedInventory?.bytes === inventory.totals.bytes,
        }
      : {}),
    groups: stagedPathGroups(inventory.files),
    files: inventory.files,
    notStagedByHarness: notStaged,
  };
}

async function main(): Promise<void> {
  const [command, targetDir, ...args] = process.argv.slice(2);

  if (command !== 'sync-assets' || !targetDir) {
    console.error(usage());
    process.exit(1);
  }

  await syncAssets(targetDir, parseSyncOptions(args));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
