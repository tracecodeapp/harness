#!/usr/bin/env npx tsx

import { mkdtemp, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

function assertCondition(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

async function main(): Promise<void> {
  const tempRoot = await mkdtemp(join(tmpdir(), 'tracecode-harness-assets-'));
  const targetDir = join(tempRoot, 'public', 'workers');

  const run = spawnSync('node', ['dist/cli.js', 'sync-assets', targetDir], {
    cwd: resolve(process.cwd()),
    encoding: 'utf8',
  });

  if (run.status !== 0) {
    throw new Error(run.stderr || run.stdout || 'Asset sync CLI failed');
  }

  const requiredFiles = [
    'pyodide-worker.js',
    'generated-python-harness-snippets.js',
    'pyodide/runtime-core.js',
    'javascript-worker.js',
    'vendor/typescript.js',
  ];

  for (const relativePath of requiredFiles) {
    const filePath = join(targetDir, relativePath);
    const fileStat = await stat(filePath);
    assertCondition(fileStat.isFile(), `Expected synced asset at ${relativePath}`);
  }

  const rootEntries = await readdir(targetDir);
  assertCondition(rootEntries.includes('pyodide-worker.js'), 'Asset sync should flatten the Python worker into the target root');
  assertCondition(rootEntries.includes('javascript-worker.js'), 'Asset sync should flatten the JavaScript worker into the target root');
  console.log('PASS: asset sync CLI copies the canonical worker asset set');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
