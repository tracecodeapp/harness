#!/usr/bin/env npx tsx

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCANNED_FILES = [
  'src/index.ts',
  'src/cli.ts',
  'packages/harness-browser/src/browser-harness.ts',
  'packages/harness-browser/src/index.ts',
  'packages/harness-browser/src/internal.ts',
  'packages/harness-browser/src/javascript-runtime-client.ts',
  'packages/harness-browser/src/javascript-worker-client.ts',
  'packages/harness-browser/src/pyodide-worker-client.ts',
  'packages/harness-browser/src/python-runtime-client.ts',
  'packages/harness-browser/src/runtime-assets.ts',
  'packages/harness-browser/src/runtime-capability-guards.ts',
  'packages/harness-browser/src/runtime-profiles.ts',
  'packages/harness-core/src/index.ts',
  'packages/harness-core/src/runtime-types.ts',
  'packages/harness-core/src/trace-contract.ts',
  'packages/harness-core/src/types.ts',
  'packages/harness-javascript/src/index.ts',
  'packages/harness-javascript/src/javascript-executor.ts',
  'packages/harness-javascript/src/typescript-runtime-declarations.ts',
  'packages/harness-python/src/index.ts',
  'packages/harness-python/src/python-harness-template.ts',
  'packages/harness-python/src/python-harness.ts',
  'workers/javascript/javascript-worker.js',
  'workers/python/pyodide-worker.js',
  'workers/python/runtime-core.js',
];

const FORBIDDEN_PATTERNS = [
  'tracecode-language',
  'tracecode:',
  'algoflow',
  'cloud-sync',
  'localStorage',
  '/public/workers/',
  '/lib/execution/',
];

function assertCondition(condition: boolean, message: string): void {
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

  console.log('PASS: standalone boundary guard rejects app-coupled runtime strings');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
