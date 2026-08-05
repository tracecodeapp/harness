#!/usr/bin/env node

import { copyFile, cp, mkdir, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { materializeCSharpRoleAssets } from '../scripts/csharp-role-artifacts.js';

type AssetLanguage = 'python' | 'javascript' | 'java' | 'csharp' | 'cpp';

const ASSET_COPY_PLAN = [
  {
    source: ['THIRD_PARTY_NOTICES.md'],
    target: ['THIRD_PARTY_NOTICES.md'],
  },
  {
    source: ['workers', 'python', 'python-worker.js'],
    target: ['python-worker.js'],
    languages: ['python'],
  },
  {
    source: ['workers', 'python', 'generated-python-harness-snippets.js'],
    target: ['generated-python-harness-snippets.js'],
    languages: ['python'],
  },
  {
    source: ['workers', 'python', 'runtime-core.js'],
    target: ['python', 'runtime-core.js'],
    languages: ['python'],
  },
  {
    source: ['workers', 'python', 'pyodide-0.29.3'],
    target: ['python', 'pyodide-0.29.3'],
    languages: ['python'],
  },
  {
    source: ['workers', 'shared', 'runtime-kernel-policy-classic.js'],
    target: ['shared', 'runtime-kernel-policy-classic.js'],
    languages: ['python'],
  },
  {
    source: ['workers', 'shared', 'runtime-kernel-policy.js'],
    target: ['shared', 'runtime-kernel-policy.js'],
    languages: ['python'],
  },
  {
    source: ['workers', 'javascript', 'javascript-worker.js'],
    target: ['javascript-worker.js'],
    languages: ['javascript'],
  },
  {
    source: ['workers', 'javascript', 'javascript-project-worker.js'],
    target: ['javascript-project-worker.js'],
    languages: ['javascript'],
  },
  {
    source: ['workers', 'shared', 'runtime-kernel-policy-classic.js'],
    target: ['shared', 'runtime-kernel-policy-classic.js'],
    languages: ['javascript'],
  },
  {
    source: ['workers', 'java', 'java-worker.js'],
    target: ['java-worker.js'],
    languages: ['java'],
  },
  {
    source: ['workers', 'java', 'java-runtime-worker.js'],
    target: ['java-runtime-worker.js'],
    languages: ['java'],
  },
  {
    source: ['workers', 'java', 'java-source-augmentations.js'],
    target: ['java-source-augmentations.js'],
    languages: ['java'],
  },
  {
    source: ['workers', 'shared', 'runtime-kernel-policy-classic.js'],
    target: ['shared', 'runtime-kernel-policy-classic.js'],
    languages: ['java'],
  },
  {
    source: ['workers', 'shared', 'tracekernel-syscall-client.js'],
    target: ['shared', 'tracekernel-syscall-client.js'],
    languages: ['java'],
  },
  {
    source: ['workers', 'shared', 'tracekernel-local-java-host.js'],
    target: ['shared', 'tracekernel-local-java-host.js'],
    languages: ['java'],
  },
  {
    source: ['workers', 'csharp', 'csharp-worker.js'],
    target: ['csharp-worker.js'],
    languages: ['csharp'],
  },
  {
    source: ['workers', 'shared', 'runtime-kernel-policy-classic.js'],
    target: ['shared', 'runtime-kernel-policy-classic.js'],
    languages: ['csharp'],
  },
  {
    source: ['workers', 'shared', 'runtime-kernel-policy.js'],
    target: ['shared', 'runtime-kernel-policy.js'],
    languages: ['csharp'],
  },
  {
    source: ['workers', 'cpp', 'cpp-worker.js'],
    target: ['cpp-worker.js'],
    languages: ['cpp'],
  },
  {
    source: ['workers', 'shared', 'runtime-kernel-policy.js'],
    target: ['shared', 'runtime-kernel-policy.js'],
    languages: ['cpp'],
  },
  {
    source: ['workers', 'cpp', 'tracecode_runtime.hpp'],
    target: ['cpp', 'tracecode_runtime.hpp'],
    languages: ['cpp'],
  },
  {
    source: ['workers', 'vendor', 'typescript.js'],
    target: ['vendor', 'typescript.js'],
    languages: ['javascript'],
  },
  {
    source: ['workers', 'vendor', 'javascript-libraries.js'],
    target: ['vendor', 'javascript-libraries.js'],
    languages: ['javascript'],
  },
  {
    source: ['workers', 'vendor', 'java-browser-helper.jar'],
    target: ['vendor', 'java-browser-helper.jar'],
    languages: ['java'],
  },
  {
    source: ['workers', 'vendor', 'csharp'],
    target: ['vendor', 'csharp'],
    languages: ['csharp'],
  },
  {
    source: ['workers', 'vendor', 'csharp-compiler'],
    target: ['vendor', 'csharp-compiler'],
    languages: ['csharp'],
  },
  {
    source: ['workers', 'vendor', 'csharp-runner'],
    target: ['vendor', 'csharp-runner'],
    languages: ['csharp'],
  },
] as const;

function usage(): string {
  return [
    'Usage:',
    '  tracecode-harness sync-assets <target-dir> [--languages python,javascript,java,csharp,cpp]',
    '',
    'Example:',
    '  tracecode-harness sync-assets public/workers',
    '  tracecode-harness sync-assets public/workers --languages python,javascript',
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

  return resolve(dirname(cliEntrypoint), '..');
}

function resolveAssetSourcePath(packageRoot: string, asset: typeof ASSET_COPY_PLAN[number]): string {
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

function parseSelectedLanguages(args: string[]): Set<AssetLanguage> | null {
  const selectedLanguages = new Set<AssetLanguage>();

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    let rawValue: string | undefined;

    if (arg === '--language' || arg === '--languages') {
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

  return selectedLanguages.size > 0 ? selectedLanguages : null;
}

function shouldCopyAsset(
  asset: typeof ASSET_COPY_PLAN[number],
  selectedLanguages: ReadonlySet<AssetLanguage> | null
): boolean {
  if (!selectedLanguages || !('languages' in asset)) return true;
  return asset.languages.some((language) => selectedLanguages.has(language));
}

async function syncAssets(targetDir: string, selectedLanguages: ReadonlySet<AssetLanguage> | null): Promise<void> {
  const packageRoot = getPackageRoot();
  const resolvedTargetDir = resolve(process.cwd(), targetDir);
  if (!selectedLanguages || selectedLanguages.has('csharp')) {
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
    if (!shouldCopyAsset(asset, selectedLanguages)) continue;
    const sourcePath = resolveAssetSourcePath(packageRoot, asset);
    const targetPath = join(resolvedTargetDir, ...asset.target);
    const sourceStat = await stat(sourcePath);
    await ensureParentDir(targetPath);
    if (sourceStat.isDirectory()) {
      await cp(sourcePath, targetPath, { recursive: true, force: true });
    } else {
      await copyFile(sourcePath, targetPath);
    }
  }

  console.log(`Synced harness assets to ${resolvedTargetDir}`);
}

async function main(): Promise<void> {
  const [command, targetDir, ...args] = process.argv.slice(2);

  if (command !== 'sync-assets' || !targetDir) {
    console.error(usage());
    process.exit(1);
  }

  await syncAssets(targetDir, parseSelectedLanguages(args));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
