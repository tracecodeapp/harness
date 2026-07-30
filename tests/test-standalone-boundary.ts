#!/usr/bin/env npx tsx

import { test } from 'node:test';
import { existsSync } from 'node:fs';
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
  'packages/runtime-browser/src/index.ts',
  'packages/runtime-browser/src/internal.ts',
  'packages/runtime-javascript/src/javascript-runtime-client.ts',
  'packages/runtime-javascript/src/javascript-worker-client.ts',
  'packages/runtime-java/src/java-runtime-client.ts',
  'packages/runtime-java/src/java-worker-client.ts',
  'packages/runtime-csharp/src/csharp-runtime-client.ts',
  'packages/runtime-csharp/src/csharp-worker-client.ts',
  'packages/runtime-python/src/python-worker-client.ts',
  'packages/runtime-python/src/python-runtime-client.ts',
  'packages/runtime-browser/src/runtime-assets.ts',
  'packages/runtime-browser/src/runtime-capability-guards.ts',
  'packages/runtime-browser/src/runtime-profiles.ts',
  'packages/runtime-browser/src/project.ts',
  'packages/runtime-core/src/index.ts',
  'packages/runtime-core/src/runtime-types.ts',
  'packages/runtime-core/src/runtime-project.ts',
  'packages/runtime-core/src/types.ts',
  'packages/workspace-facade/src/index.ts',
  'packages/workspace-facade/src/zlib-browser-shim.ts',
  'packages/runtime-native/src/index.ts',
  'packages/runtime-sql/src/index.ts',
  'packages/runtime-javascript/src/index.ts',
  'packages/runtime-javascript/src/javascript-executor.ts',
  'packages/runtime-javascript/src/project-browser.ts',
  'packages/runtime-javascript/src/project-node.ts',
  'packages/runtime-javascript/src/typescript-runtime-declarations.ts',
  'packages/runtime-java/src/index.ts',
  'packages/runtime-java/src/project-browser.ts',
  'packages/runtime-java/src/project-node.ts',
  'packages/runtime-csharp/src/index.ts',
  'packages/runtime-csharp/src/project-browser.ts',
  'packages/runtime-csharp/src/project-node.ts',
  'packages/runtime-cpp/src/index.ts',
  'packages/runtime-cpp/src/project-browser.ts',
  'packages/runtime-cpp/src/project-node.ts',
  'packages/runtime-python/src/index.ts',
  'packages/runtime-python/src/project-browser.ts',
  'packages/runtime-python/src/project-node.ts',
  'packages/runtime-python/src/python-harness-template.ts',
  'packages/runtime-python/src/python-harness.ts',
  'workers/javascript/javascript-worker.js',
  'workers/java/java-worker.js',
  'workers/java/java-source-augmentations.js',
  'workers/csharp/csharp-worker.js',
  'workers/python/python-worker.js',
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
  const clientOwnership = [
    ['cpp-runtime-client.ts', 'cpp-runtime-client.ts', 'runtime-cpp'],
    ['cpp-worker-client.ts', 'cpp-worker-client.ts', 'runtime-cpp'],
    ['csharp-runtime-client.ts', 'csharp-runtime-client.ts', 'runtime-csharp'],
    ['csharp-worker-client.ts', 'csharp-worker-client.ts', 'runtime-csharp'],
    ['java-runtime-client.ts', 'java-runtime-client.ts', 'runtime-java'],
    ['java-storage-isolation.ts', 'java-storage-isolation.ts', 'runtime-java'],
    ['java-worker-client.ts', 'java-worker-client.ts', 'runtime-java'],
    ['javascript-runtime-client.ts', 'javascript-runtime-client.ts', 'runtime-javascript'],
    ['javascript-worker-client.ts', 'javascript-worker-client.ts', 'runtime-javascript'],
    ['python-runtime-client.ts', 'python-runtime-client.ts', 'runtime-python'],
    ['pyodide-worker-client.ts', 'python-worker-client.ts', 'runtime-python'],
  ] as const;
  for (const [oldFileName, fileName, ownerPackage] of clientOwnership) {
    assertCondition(
      !existsSync(join(ROOT, 'packages/runtime-browser/src', oldFileName)),
      `${oldFileName} must not remain owned by @tracecode/runtime-browser`
    );
    assertCondition(
      existsSync(join(ROOT, `packages/${ownerPackage}/src`, fileName)),
      `${fileName} must be owned by @tracecode/${ownerPackage}`
    );
  }

  const browserPackage = JSON.parse(
    await readFile(join(ROOT, 'packages/runtime-browser/package.json'), 'utf8')
  ) as { dependencies?: Record<string, string> };
  for (const languagePackage of [
    'runtime-python',
    'runtime-javascript',
    'runtime-java',
    'runtime-csharp',
    'runtime-cpp',
  ]) {
    assertCondition(
      !Object.prototype.hasOwnProperty.call(
        browserPackage.dependencies ?? {},
        `@tracecode/${languagePackage}`
      ),
      `@tracecode/runtime-browser must not depend on @tracecode/${languagePackage}`
    );
    const languageManifest = JSON.parse(
      await readFile(join(ROOT, `packages/${languagePackage}/package.json`), 'utf8')
    ) as { dependencies?: Record<string, string> };
    assertCondition(
      languageManifest.dependencies?.['@tracecode/runtime-browser'] === 'workspace:*',
      `@tracecode/${languagePackage} must depend on the generic browser host`
    );
  }

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
    entryPoints: [join(ROOT, 'packages/runtime-browser/src/index.ts')],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    external: ['typescript'],
    metafile: true,
    write: false,
  });
  const projectImplementationInputs = Object.keys(classicBrowserBundle.metafile?.inputs ?? {})
    .filter((input) =>
      input.includes('/workspace-facade/') ||
      input.endsWith('/project-browser.ts') ||
      input.endsWith('/runtime-browser/src/project.ts')
    );
  assertCondition(
    projectImplementationInputs.length === 0,
    `Classic browser entry must not bundle project implementations; use the explicit browser/project entry instead. Found: ${projectImplementationInputs.join(', ')}`
  );
  const classicBrowserOutput = classicBrowserBundle.outputFiles.map((file) => file.text).join('\n');
  const languageImplementationInputs = Object.keys(classicBrowserBundle.metafile?.inputs ?? {})
    .filter((input) =>
      /\/runtime-(?:python|javascript|java|csharp|cpp)\/src\//u.test(input)
    );
  assertCondition(
    languageImplementationInputs.length === 0,
    `Classic browser entry must receive language providers through registry injection. Found: ${languageImplementationInputs.join(', ')}`
  );
  assertCondition(
    !classicBrowserOutput.includes('localStorage'),
    'Classic browser entry must not bundle same-origin storage authority; project workers may explicitly deny it.'
  );

  console.log('PASS: standalone boundary guard rejects app coupling and keeps project code out of the Classic entry');
}

test('standalone boundary', main);
