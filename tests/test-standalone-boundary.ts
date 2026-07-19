#!/usr/bin/env npx tsx

import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { build } from 'esbuild';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCANNED_FILES = [
  'src/index.ts',
  'src/cli.ts',
  'src/native.ts',
  'src/sql.ts',
  'packages/harness-browser/src/browser-harness.ts',
  'packages/harness-browser/src/index.ts',
  'packages/harness-browser/src/internal.ts',
  'packages/harness-browser/src/javascript-runtime-client.ts',
  'packages/harness-browser/src/javascript-worker-client.ts',
  'packages/harness-browser/src/java-runtime-client.ts',
  'packages/harness-browser/src/java-worker-client.ts',
  'packages/harness-browser/src/csharp-runtime-client.ts',
  'packages/harness-browser/src/csharp-worker-client.ts',
  'packages/harness-browser/src/pyodide-worker-client.ts',
  'packages/harness-browser/src/python-runtime-client.ts',
  'packages/harness-browser/src/runtime-assets.ts',
  'packages/harness-browser/src/runtime-capability-guards.ts',
  'packages/harness-browser/src/runtime-profiles.ts',
  'packages/harness-browser/src/project.ts',
  'packages/harness-core/src/index.ts',
  'packages/harness-core/src/runtime-types.ts',
  'packages/harness-core/src/runtime-project.ts',
  'packages/harness-core/src/types.ts',
  'packages/harness-project/src/index.ts',
  'packages/harness-project/src/zlib-browser-shim.ts',
  'packages/harness-native/src/index.ts',
  'packages/harness-sql/src/index.ts',
  'packages/harness-javascript/src/index.ts',
  'packages/harness-javascript/src/javascript-executor.ts',
  'packages/harness-javascript/src/project-browser.ts',
  'packages/harness-javascript/src/project-node.ts',
  'packages/harness-javascript/src/typescript-runtime-declarations.ts',
  'packages/harness-java/src/index.ts',
  'packages/harness-java/src/project-browser.ts',
  'packages/harness-java/src/project-node.ts',
  'packages/harness-csharp/src/index.ts',
  'packages/harness-csharp/src/project-browser.ts',
  'packages/harness-csharp/src/project-node.ts',
  'packages/harness-cpp/src/index.ts',
  'packages/harness-cpp/src/project-browser.ts',
  'packages/harness-cpp/src/project-node.ts',
  'packages/harness-python/src/index.ts',
  'packages/harness-python/src/project-browser.ts',
  'packages/harness-python/src/project-node.ts',
  'packages/harness-python/src/python-harness-template.ts',
  'packages/harness-python/src/python-harness.ts',
  'workers/javascript/javascript-worker.js',
  'workers/java/java-worker.js',
  'workers/java/java-source-augmentations.js',
  'workers/csharp/csharp-worker.js',
  'workers/python/pyodide-worker.js',
  'workers/python/runtime-core.js',
];

const FORBIDDEN_PATTERNS = [
  'tracecode-language',
  'tracecode:',
  'algoflow',
  'cloud-sync',
  '/public/workers/',
  '/lib/execution/',
];

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

async function main(): Promise<void> {
  for (const relativePath of SCANNED_FILES) {
    const content = await readFile(join(ROOT, relativePath), 'utf8');

    for (const forbiddenPattern of FORBIDDEN_PATTERNS) {
      assertCondition(
        !content.includes(forbiddenPattern),
        `Standalone boundary regression: "${forbiddenPattern}" found in ${relativePath}`
      );
    }
  }

  const classicBrowserBundle = await build({
    entryPoints: [join(ROOT, 'packages/harness-browser/src/index.ts')],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    external: ['typescript'],
    metafile: true,
    write: false,
  });
  const projectImplementationInputs = Object.keys(classicBrowserBundle.metafile?.inputs ?? {})
    .filter((input) =>
      input.includes('/harness-project/') ||
      input.endsWith('/project-browser.ts') ||
      input.endsWith('/harness-browser/src/project.ts')
    );
  assertCondition(
    projectImplementationInputs.length === 0,
    `Classic browser entry must not bundle project implementations; use the explicit browser/project entry instead. Found: ${projectImplementationInputs.join(', ')}`
  );
  const classicBrowserOutput = classicBrowserBundle.outputFiles.map((file) => file.text).join('\n');
  assertCondition(
    !classicBrowserOutput.includes('localStorage'),
    'Classic browser entry must not bundle same-origin storage authority; project workers may explicitly deny it.'
  );

  console.log('PASS: standalone boundary guard rejects app coupling and keeps project code out of the Classic entry');
}

test('standalone boundary', main);
