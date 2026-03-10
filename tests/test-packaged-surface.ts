#!/usr/bin/env npx tsx

import { mkdtemp, mkdir, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';

function assertCondition(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

async function main(): Promise<void> {
  const tempRoot = await mkdtemp(join(tmpdir(), 'tracecode-harness-pack-'));
  const packOutput = spawnSync('pnpm', ['pack', '--pack-destination', tempRoot], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });

  if (packOutput.status !== 0) {
    throw new Error(packOutput.stderr || packOutput.stdout || 'pnpm pack failed');
  }

  const tarballName = String(packOutput.stdout || '')
    .trim()
    .split('\n')
    .filter(Boolean)
    .at(-1);
  assertCondition(Boolean(tarballName), 'pnpm pack should print the generated tarball name');

  const packageDir = join(tempRoot, 'app', 'node_modules', '@tracecode', 'harness');
  await mkdir(packageDir, { recursive: true });

  const tarballPath = isAbsolute(tarballName!) ? tarballName! : join(tempRoot, tarballName!);
  const extract = spawnSync('tar', ['-xf', tarballPath, '-C', packageDir, '--strip-components=1'], {
    encoding: 'utf8',
  });
  if (extract.status !== 0) {
    throw new Error(extract.stderr || extract.stdout || 'Failed to extract packed harness tarball');
  }

  const requiredPackagedFiles = [
    'dist/index.js',
    'dist/index.cjs',
    'dist/browser.js',
    'dist/browser.cjs',
    'dist/core.js',
    'dist/core.cjs',
    'dist/python.js',
    'dist/python.cjs',
    'dist/javascript.js',
    'dist/javascript.cjs',
    'workers/python/pyodide-worker.js',
    'workers/javascript/javascript-worker.js',
    'workers/vendor/typescript.js',
  ];

  for (const relativePath of requiredPackagedFiles) {
    const filePath = join(packageDir, relativePath);
    const fileStat = await stat(filePath);
    assertCondition(fileStat.isFile(), `Packed tarball should include ${relativePath}`);
  }

  const appDir = join(tempRoot, 'app');
  const evalScript = `
    (async () => {
      const browserRequire = require('@tracecode/harness/browser');
      if (typeof browserRequire.createBrowserHarness !== 'function') {
        throw new Error('Missing CommonJS browser export');
      }

      const root = await import('@tracecode/harness');
      const browser = await import('@tracecode/harness/browser');
      const core = await import('@tracecode/harness/core');
      const python = await import('@tracecode/harness/python');
      const javascript = await import('@tracecode/harness/javascript');

      if (typeof browser.createBrowserHarness !== 'function') throw new Error('Missing createBrowserHarness export');
      if ('getPyodideWorkerClient' in browser) throw new Error('Low-level worker clients should not be publicly exported');
      if ('enforceRuntimeWorkerIsolation' in browser) throw new Error('Worker isolation helpers should not be publicly exported');
      if (typeof core.normalizeRuntimeTraceContract !== 'function') throw new Error('Missing core export');
      if (typeof python.generateSolutionScript !== 'function') throw new Error('Missing python export');
      if (typeof javascript.executeJavaScriptCode !== 'function') throw new Error('Missing javascript export');
      if (typeof root.createBrowserHarness !== 'function') throw new Error('Root export should expose createBrowserHarness');
      console.log('ok');
    })().catch((error) => {
      console.error(error);
      process.exit(1);
    });
  `;
  const run = spawnSync('node', ['-e', evalScript], {
    cwd: appDir,
    encoding: 'utf8',
  });

  if (run.status !== 0) {
    throw new Error(run.stderr || run.stdout || 'Packed surface import check failed');
  }

  console.log('PASS: packaged public surface imports through published subpaths');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
