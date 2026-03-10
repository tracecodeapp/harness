#!/usr/bin/env npx tsx

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  runCommand,
  runExampleBrowserSmoke,
  startPreviewServer,
  waitForHttp,
} from './example-app-smoke';

async function main(): Promise<void> {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
  const exampleDir = join(repoRoot, 'examples', 'web-ide');
  const previewPort = 4300 + Math.floor(Math.random() * 200);

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

  console.log('PASS: example web IDE boots and runs all supported browser runtimes');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
