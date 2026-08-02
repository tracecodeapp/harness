#!/usr/bin/env npx tsx

import {
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  rename,
  rm,
  stat,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = resolve(process.cwd());
const require = createRequire(pathToFileURL(join(ROOT, 'scripts', 'sync-language-package-assets.ts')));

interface PackageAsset {
  source: string[];
  target: string[];
  packageName?: string;
}

interface PackageAssetPlan {
  packageDir: string;
  assets: PackageAsset[];
}

const SHARED_PACKAGE_FILES = ['LICENSE', 'THIRD_PARTY_NOTICES.md'] as const;

const PACKAGE_ASSET_PLANS: PackageAssetPlan[] = [
  {
    packageDir: 'packages/tracekernel',
    assets: [],
  },
  {
    packageDir: 'packages/runtime-contracts',
    assets: [],
  },
  {
    packageDir: 'packages/judge',
    assets: [],
  },
  {
    packageDir: 'packages/runtime-browser',
    assets: [],
  },
  {
    packageDir: 'packages/runtime-sql',
    assets: [],
  },
  {
    packageDir: 'packages/runtime-native',
    assets: [
      {
        source: ['workers', 'python', 'runtime-core.js'],
        target: ['workers', 'python', 'runtime-core.js'],
      },
      {
        source: ['workers', 'javascript', 'javascript-worker.js'],
        target: ['workers', 'javascript', 'javascript-worker.js'],
      },
      {
        source: ['workers', 'vendor', 'typescript.js'],
        target: ['workers', 'vendor', 'typescript.js'],
      },
      {
        source: ['workers', 'vendor', 'javascript-libraries.js'],
        target: ['workers', 'vendor', 'javascript-libraries.js'],
      },
      {
        source: ['workers', 'java', 'java-worker.js'],
        target: ['workers', 'java', 'java-worker.js'],
      },
      {
        source: ['workers', 'vendor', 'java-browser-helper.jar'],
        target: ['workers', 'vendor', 'java-browser-helper.jar'],
      },
      {
        source: ['workers', 'cpp', 'cpp-worker.js'],
        target: ['workers', 'cpp', 'cpp-worker.js'],
      },
      {
        source: ['workers', 'cpp', 'tracecode_runtime.hpp'],
        target: ['workers', 'cpp', 'tracecode_runtime.hpp'],
      },
    ],
  },
  {
    packageDir: 'packages/runtime-python',
    assets: [
      {
        source: ['workers', 'python', 'python-worker.js'],
        target: ['workers', 'python-worker.js'],
      },
      {
        source: ['workers', 'python', 'generated-python-harness-snippets.js'],
        target: ['workers', 'generated-python-harness-snippets.js'],
      },
      {
        source: ['workers', 'python', 'runtime-core.js'],
        target: ['workers', 'python', 'runtime-core.js'],
      },
      {
        source: ['workers', 'shared', 'runtime-kernel-policy-classic.js'],
        target: ['workers', 'shared', 'runtime-kernel-policy-classic.js'],
      },
      {
        source: ['workers', 'shared', 'runtime-kernel-policy.js'],
        target: ['workers', 'shared', 'runtime-kernel-policy.js'],
      },
    ],
  },
  {
    packageDir: 'packages/runtime-javascript',
    assets: [
      {
        source: ['workers', 'javascript', 'javascript-worker.js'],
        target: ['workers', 'javascript-worker.js'],
      },
      {
        source: ['workers', 'javascript', 'javascript-project-worker.js'],
        target: ['workers', 'javascript-project-worker.js'],
      },
      {
        source: ['workers', 'shared', 'runtime-kernel-policy-classic.js'],
        target: ['workers', 'shared', 'runtime-kernel-policy-classic.js'],
      },
      {
        source: ['workers', 'vendor', 'typescript.js'],
        target: ['workers', 'vendor', 'typescript.js'],
      },
      {
        source: ['workers', 'vendor', 'javascript-libraries.js'],
        target: ['workers', 'vendor', 'javascript-libraries.js'],
      },
    ],
  },
  {
    packageDir: 'packages/runtime-java',
    assets: [
      {
        source: ['workers', 'java', 'java-worker.js'],
        target: ['workers', 'java-worker.js'],
      },
      {
        source: ['workers', 'java', 'java-runtime-worker.js'],
        target: ['workers', 'java-runtime-worker.js'],
      },
      {
        source: ['workers', 'java', 'java-source-augmentations.js'],
        target: ['workers', 'java-source-augmentations.js'],
      },
      {
        source: ['workers', 'shared', 'runtime-kernel-policy-classic.js'],
        target: ['workers', 'shared', 'runtime-kernel-policy-classic.js'],
      },
      {
        source: ['workers', 'shared', 'tracekernel-syscall-client.js'],
        target: ['workers', 'shared', 'tracekernel-syscall-client.js'],
      },
      {
        source: ['workers', 'vendor', 'java-browser-helper.jar'],
        target: ['workers', 'vendor', 'java-browser-helper.jar'],
      },
    ],
  },
  {
    packageDir: 'packages/runtime-csharp',
    assets: [
      {
        source: ['workers', 'csharp', 'csharp-worker.js'],
        target: ['workers', 'csharp-worker.js'],
      },
      {
        source: ['workers', 'shared', 'runtime-kernel-policy-classic.js'],
        target: ['workers', 'shared', 'runtime-kernel-policy-classic.js'],
      },
      {
        source: ['workers', 'shared', 'runtime-kernel-policy.js'],
        target: ['workers', 'shared', 'runtime-kernel-policy.js'],
      },
      {
        source: ['workers', 'vendor', 'csharp'],
        target: ['workers', 'vendor', 'csharp'],
      },
    ],
  },
  {
    packageDir: 'packages/runtime-cpp',
    assets: [
      {
        source: ['workers', 'cpp', 'cpp-worker.js'],
        target: ['workers', 'cpp-worker.js'],
      },
      {
        source: ['workers', 'shared', 'runtime-kernel-policy.js'],
        target: ['workers', 'shared', 'runtime-kernel-policy.js'],
      },
      {
        source: ['workers', 'cpp', 'cpp-compiler-frame.html'],
        target: ['workers', 'cpp-compiler-frame.html'],
      },
      {
        source: ['workers', 'cpp', 'cpp-compiler-worker.js'],
        target: ['workers', 'cpp-compiler-worker.js'],
      },
      {
        source: ['workers', 'cpp', 'tracecode_runtime.hpp'],
        target: ['workers', 'cpp', 'tracecode_runtime.hpp'],
      },
      {
        packageName: '@yowasp/clang',
        source: ['gen', 'bundle.js'],
        target: ['workers', 'cpp', 'compiler', 'bundle.js'],
      },
      {
        packageName: '@yowasp/clang',
        source: ['gen', 'llvm-resources.tar'],
        target: ['workers', 'cpp', 'compiler', 'llvm-resources.tar'],
      },
      {
        packageName: '@yowasp/clang',
        source: ['gen', 'llvm.core.wasm'],
        target: ['workers', 'cpp', 'compiler', 'llvm.core.wasm'],
      },
      {
        packageName: '@yowasp/clang',
        source: ['gen', 'llvm.core2.wasm'],
        target: ['workers', 'cpp', 'compiler', 'llvm.core2.wasm'],
      },
      {
        packageName: '@yowasp/clang',
        source: ['gen', 'llvm.core3.wasm'],
        target: ['workers', 'cpp', 'compiler', 'llvm.core3.wasm'],
      },
      {
        packageName: '@yowasp/clang',
        source: ['gen', 'llvm.core4.wasm'],
        target: ['workers', 'cpp', 'compiler', 'llvm.core4.wasm'],
      },
    ],
  },
];

function resolveSourcePath(asset: PackageAsset): string {
  if (asset.packageName) {
    const packageEntrypoint = require.resolve(asset.packageName);
    return join(dirname(dirname(packageEntrypoint)), ...asset.source);
  }
  return join(ROOT, ...asset.source);
}

async function copyPath(sourcePath: string, targetPath: string): Promise<void> {
  const sourceStat = await stat(sourcePath);
  await mkdir(dirname(targetPath), { recursive: true });
  if (sourceStat.isDirectory()) {
    await cp(sourcePath, targetPath, { recursive: true, force: true });
    return;
  }
  await copyFile(sourcePath, targetPath);
}

async function syncPackage(plan: PackageAssetPlan): Promise<void> {
  const packageRoot = join(ROOT, plan.packageDir);

  for (const sharedFile of SHARED_PACKAGE_FILES) {
    await copyPath(join(ROOT, sharedFile), join(packageRoot, sharedFile));
  }

  const workersTarget = join(packageRoot, 'workers');
  if (plan.assets.length === 0) {
    await rm(workersTarget, { recursive: true, force: true });
    return;
  }

  const stagingRoot = await mkdtemp(join(packageRoot, '.workers-sync-'));
  const previousWorkers = join(stagingRoot, 'previous-workers');
  try {
    for (const asset of plan.assets) {
      await copyPath(
        resolveSourcePath(asset),
        join(stagingRoot, ...asset.target)
      );
    }
    try {
      await rename(workersTarget, previousWorkers);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    try {
      await rename(join(stagingRoot, 'workers'), workersTarget);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST' && code !== 'ENOTEMPTY') throw error;
      // Another identical sync won the atomic publication race.
    }
    await rm(previousWorkers, { recursive: true, force: true });
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  for (const plan of PACKAGE_ASSET_PLANS) {
    await syncPackage(plan);
  }
  console.log('Synced language package assets');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
