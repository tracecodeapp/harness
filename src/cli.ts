#!/usr/bin/env node

import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

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
    source: ['workers', 'vendor', 'typescript.js'],
    target: ['vendor', 'typescript.js'],
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

async function syncAssets(targetDir: string): Promise<void> {
  const packageRoot = getPackageRoot();
  const resolvedTargetDir = resolve(process.cwd(), targetDir);

  for (const asset of ASSET_COPY_PLAN) {
    const sourcePath = join(packageRoot, ...asset.source);
    const targetPath = join(resolvedTargetDir, ...asset.target);
    await ensureParentDir(targetPath);
    await copyFile(sourcePath, targetPath);
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
