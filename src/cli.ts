#!/usr/bin/env node

import { copyFile, cp, mkdir, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(pathToFileURL(process.argv[1] ?? join(process.cwd(), 'tracecode-harness.js')));

const ASSET_COPY_PLAN = [
  {
    source: ['workers', 'python', 'pyodide-worker.js'],
    target: ['pyodide-worker.js'],
  },
  {
    source: ['workers', 'python', 'generated-python-harness-snippets.js'],
    target: ['generated-python-harness-snippets.js'],
  },
  {
    source: ['workers', 'python', 'runtime-core.js'],
    target: ['pyodide', 'runtime-core.js'],
  },
  {
    source: ['workers', 'javascript', 'javascript-worker.js'],
    target: ['javascript-worker.js'],
  },
  {
    source: ['workers', 'java', 'java-worker.js'],
    target: ['java-worker.js'],
  },
  {
    source: ['workers', 'java', 'java-source-augmentations.js'],
    target: ['java-source-augmentations.js'],
  },
  {
    source: ['workers', 'csharp', 'csharp-worker.js'],
    target: ['csharp-worker.js'],
  },
  {
    source: ['workers', 'cpp', 'cpp-worker.js'],
    target: ['cpp-worker.js'],
  },
  {
    source: ['workers', 'cpp', 'tracecode_runtime.hpp'],
    target: ['cpp', 'tracecode_runtime.hpp'],
  },
  {
    packageName: '@yowasp/clang',
    source: ['gen', 'bundle.js'],
    target: ['vendor', 'cpp', 'yowasp', 'bundle.js'],
  },
  {
    packageName: '@yowasp/clang',
    source: ['gen', 'llvm-resources.tar'],
    target: ['vendor', 'cpp', 'yowasp', 'llvm-resources.tar'],
  },
  {
    packageName: '@yowasp/clang',
    source: ['gen', 'llvm.core.wasm'],
    target: ['vendor', 'cpp', 'yowasp', 'llvm.core.wasm'],
  },
  {
    packageName: '@yowasp/clang',
    source: ['gen', 'llvm.core2.wasm'],
    target: ['vendor', 'cpp', 'yowasp', 'llvm.core2.wasm'],
  },
  {
    packageName: '@yowasp/clang',
    source: ['gen', 'llvm.core3.wasm'],
    target: ['vendor', 'cpp', 'yowasp', 'llvm.core3.wasm'],
  },
  {
    packageName: '@yowasp/clang',
    source: ['gen', 'llvm.core4.wasm'],
    target: ['vendor', 'cpp', 'yowasp', 'llvm.core4.wasm'],
  },
  {
    source: ['workers', 'vendor', 'typescript.js'],
    target: ['vendor', 'typescript.js'],
  },
  {
    source: ['workers', 'vendor', 'java-browser-helper.jar'],
    target: ['vendor', 'java-browser-helper.jar'],
  },
  {
    source: ['workers', 'vendor', 'java-rewriter.jar'],
    target: ['vendor', 'java-rewriter.jar'],
  },
  {
    source: ['workers', 'vendor', 'javaparser-core-3.25.10.jar'],
    target: ['vendor', 'javaparser-core-3.25.10.jar'],
  },
  {
    source: ['workers', 'vendor', 'jdk.compiler-17.jar'],
    target: ['vendor', 'jdk.compiler-17.jar'],
  },
  {
    source: ['workers', 'vendor', 'csharp'],
    target: ['vendor', 'csharp'],
  },
] as const;

function usage(): string {
  return [
    'Usage:',
    '  tracecode-harness sync-assets <target-dir>',
    '',
    'Example:',
    '  tracecode-harness sync-assets public/workers',
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
  if ('packageName' in asset) {
    const packageEntrypoint = require.resolve(asset.packageName);
    return join(dirname(dirname(packageEntrypoint)), ...asset.source);
  }
  return join(packageRoot, ...asset.source);
}

async function syncAssets(targetDir: string): Promise<void> {
  const packageRoot = getPackageRoot();
  const resolvedTargetDir = resolve(process.cwd(), targetDir);

  for (const asset of ASSET_COPY_PLAN) {
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
  const [command, targetDir] = process.argv.slice(2);

  if (command !== 'sync-assets' || !targetDir) {
    console.error(usage());
    process.exit(1);
  }

  await syncAssets(targetDir);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
