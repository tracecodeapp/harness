#!/usr/bin/env npx tsx

import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  assertCondition,
  runCommand,
  runExampleBrowserSmoke,
  startPreviewServer,
  waitForHttp,
} from './example-app-smoke';

async function main(): Promise<void> {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
  const exampleDir = join(repoRoot, 'examples', 'web-ide');
  const previewPort = 4300 + Math.floor(Math.random() * 200);

  const exampleSource = await readFile(
    join(exampleDir, 'src', 'main.ts'),
    'utf8',
  );
  for (const requiredPublicApi of [
    'createBrowserJudgeHost',
    'judgeHost.createJudge',
    'Effect.scoped',
    'signal: controller.signal',
    'judgeHost.dispose()',
    'VITE_JAVA_RUNTIME_ASSET_BASE_URL',
    'runtimeAssetBaseUrl: javaRuntimeAssetBaseUrl',
  ]) {
    assertCondition(
      exampleSource.includes(requiredPublicApi),
      `Example source must demonstrate ${requiredPublicApi}`,
    );
  }
  for (const retiredSurface of [
    'createBrowserHarness',
    '.getClient(',
    '.executeCode(',
    '.executeWithTracing(',
    'BrowserRuntimeAssetManifest',
    '@tracecode/harness/core',
    'cjrtnc.leaningtech.com',
  ]) {
    assertCondition(
      !exampleSource.includes(retiredSurface),
      `Example source must not use retired surface ${retiredSurface}`,
    );
  }

  await runCommand('pnpm', ['--dir', exampleDir, 'build'], repoRoot);

  const preview = startPreviewServer(
    'pnpm',
    ['exec', 'vite', 'preview', '--host', '127.0.0.1', '--port', String(previewPort), '--strictPort'],
    exampleDir
  );

  try {
    const previewUrl = await preview.waitForUrl;
    await waitForHttp(previewUrl, 30_000);
    await runExampleBrowserSmoke(previewUrl);
  } finally {
    if (!preview.process.killed) {
      preview.process.kill('SIGTERM');
    }
    await preview.waitForExit;
  }

  console.log('PASS: example web IDE boots and runs all enabled browser runtimes');
}

test('example app', main);
